"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type FocusEvent,
  type MouseEvent,
} from "react";
import type { ScreeningCloseApproach, ScreeningResult } from "@/lib/prompts";
import {
  ISS_NORAD_ID,
  ISS_PC_RED_THRESHOLD,
  STARLINK_PC_MANEUVER_THRESHOLD,
  formatDuration,
  formatUtc,
  type RicVector,
  type StateVector,
} from "@/lib/orbital";
import { DEFAULT_SCREENING_OPTIONS } from "@/lib/screening";
import {
  CW_CHECK_REFERENCE_DV_MPS,
  CW_VALID_MAX_ECCENTRICITY,
  CW_VALID_MAX_ERROR,
  DEFAULT_LEADS_SECONDS,
  FINITE_BURN_SUBSTEPS,
  VEHICLE_PRESETS,
  checkLinearisation,
  evaluateTradeGrid,
  finalizeTradeSpace,
  isUsableState,
  pcDilution,
  pcSensitivity,
  tradeCellKey,
  type BurnDirection,
  type LinearisationCheck,
  type PcDilution,
  type PcSensitivityPoint,
  type TradeCell,
  type TradeGrid,
  type TradeSpace,
} from "@/lib/maneuver";
import { timedFetch } from "@/lib/telemetry";

/* ============================================================
   Session 6 — Feature 2: Avoidance Burn Planner

   The decision core of an autonomous collision-avoidance system,
   built deterministically on top of the SGP4 conjunction screen:
   evaluate a trade space of single in-track burns with linearised
   (Clohessy-Wiltshire) relative motion, re-evaluate Pc for each,
   and pick the minimum-Δv burn that clears a Starlink-style
   decision rule (maneuver when Pc ≥ 3e-7; NASA's 1e-4 red line when the
   screened target is the ISS). The burn is recommended
   only once a two-body re-solve with no linearisation confirms it.
   The linearisation is also checked live for this geometry, and the
   panel says "verified" only when it holds.

   Data flow
   - RUN → timedFetch("/api/screen?target=&hours=") (the route's
     5-min per-target cache serves it instantly if the Conjunction
     Screener already ran the same target + window). Every close
     approach now carries both ECI states at TCA (targetStateEci /
     secondaryStateEci, filled by lib/screening).
   - The event picker lists the 5 highest-Pc approaches (ties → closest):
     Pc is what the decision rule uses, and under the anisotropic
     covariance it does not fall monotonically with miss distance. The
     default selection is the highest-Pc one.
   - Everything else is computed in the browser by lib/maneuver
     (pure):
     - evaluateTradeGrid: 8 leads × 7 Δv × 2 directions = 112 CW cells,
       ~35 ms. Memoised per event, vehicle and covariance.
     - finalizeTradeSpace: the time-remaining constraint, plus the walk
       that re-solves CW candidates on Keplerian arcs until one also
       clears the rule there. Cheap, and reuses the grid's two-body
       memo.
     - checkLinearisation: 16 two-body burns; encounter-plane error
       and osculating eccentricity.
     - pcSensitivity + pcDilution.
   - Cadence: on demand only (no polling). A 60 s clock keeps the
     "time remaining until TCA" current, so burns that would have to
     start in the past are marked infeasible. A tick only re-runs
     finalizeTradeSpace and keeps an open cell tooltip.

   ASSUMPTIONS (printed in the footnote)
   - CW linearised relative motion about a circular reference orbit,
     checked against two-body propagation. When the encounter-plane
     error exceeds 2 % or the orbit is eccentric, the heat map is
     labelled indicative only. J2 / drag differential effects are not
     modelled.
   - In-track burns only, centred on the lead time, modelled as
     finite constant-thrust arcs (CW superposition of 16 impulses).
   - Pc under the screen's ASSUMED TLE-grade covariance (σ RIC per
     object, combined hard-body radius) — not an operator covariance.
   - Propellant / burn time treat the screened target AS the selected
     vehicle preset; mass / Isp / thrust are public estimates.
   - The secondary does not maneuver.
   A planning aid — not flight software, not an operator product.
   ============================================================ */

const DEFAULT_TARGET = "ISS";
const DEFAULT_HOURS = 24;
const WINDOW_OPTIONS: readonly number[] = [12, 24, 48];
const MAX_EVENTS = 5;
const CLOCK_TICK_MS = 60_000;
const PC_FLOOR = 1e-15;

const COLOR_SAFE = "#00FF41";
const COLOR_CAUTION = "#FFB800";
const COLOR_DANGER = "#FF3131";
const COLOR_DATA = "#5FB3FF";

const BG_RED = "rgba(255,49,49,0.35)";
const BG_AMBER = "rgba(255,184,0,0.35)";
const BG_GREEN = "rgba(0,255,65,0.25)";
const HATCH =
  "repeating-linear-gradient(135deg, rgba(255,255,255,0.10) 0px, rgba(255,255,255,0.10) 2px, transparent 2px, transparent 6px)";

/* ------------------------------------------------------------
   Formatting helpers — every value is guarded (no NaN / undefined)
   ------------------------------------------------------------ */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function fmtFixed(v: unknown, dp: number): string {
  return isFiniteNumber(v) ? v.toFixed(dp) : "—";
}

function fmtSigned(v: unknown, dp: number): string {
  if (!isFiniteNumber(v)) return "—";
  const abs = Math.abs(v).toFixed(dp);
  // Rounds to zero at this precision → no sign (never "−0.000").
  if (Number(abs) === 0) return abs;
  return v < 0 ? `−${abs}` : `+${abs}`;
}

function fmtPc(v: unknown, dp = 2): string {
  if (!isFiniteNumber(v)) return "—";
  if (v <= 0) return "0";
  if (v < 1e-99) return "<1e-99";
  return v.toExponential(dp);
}

/** Miss distance in a heat-map cell (1 dp, 0 dp from 100 km). */
function fmtCellMiss(km: number): string {
  if (!Number.isFinite(km)) return "—";
  return km >= 100 ? km.toFixed(0) : km.toFixed(1);
}

function fmtLead(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function fmtCmPerS(dvMps: number): string {
  const cm = Math.round(dvMps * 1000) / 10;
  return Number.isInteger(cm) ? `${cm}` : cm.toFixed(1);
}

function fmtSignedDv(cell: Pick<TradeCell, "dvMps" | "direction">): string {
  return `${cell.direction === "PROGRADE" ? "+" : "−"}${fmtCmPerS(cell.dvMps)} cm/s`;
}

function fmtPropellant(kg: number): string {
  if (!Number.isFinite(kg) || kg < 0) return "—";
  const g = kg * 1000;
  if (g < 1) return `${g.toFixed(2)} g`;
  if (g < 100) return `${g.toFixed(1)} g`;
  if (g < 1000) return `${g.toFixed(0)} g`;
  return `${kg.toFixed(2)} kg`;
}

function fmtBurn(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function fmtRic(v: RicVector, dp = 3): string {
  return `R ${fmtSigned(v.radialKm, dp)} · I ${fmtSigned(v.inTrackKm, dp)} · C ${fmtSigned(
    v.crossTrackKm,
    dp
  )} km`;
}

function fmtPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  const pct = fraction * 100;
  return pct < 0.01 ? "<0.01" : pct < 10 ? pct.toFixed(2) : pct.toFixed(1);
}

function fmtEcc(e: number): string {
  if (!Number.isFinite(e)) return "—";
  return e < 1e-4 ? "<0.0001" : e.toFixed(4);
}

/** CW clears the rule but the two-body re-solve does not (or failed): never recommended. */
function isTwoBodyRejected(c: TradeCell): boolean {
  return c.meetsThreshold && c.twoBodyMeetsThreshold === false;
}

function parseIso(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function cellBackground(pc: number, thresholdPc: number): string {
  if (pc >= ISS_PC_RED_THRESHOLD) return BG_RED;
  if (pc >= thresholdPc) return BG_AMBER;
  return BG_GREEN;
}

function eventKey(e: ScreeningCloseApproach): string {
  return `${e.noradId}|${e.tca}`;
}

function errorMessage(data: unknown, status: number, fallback: string): string {
  if (data && typeof data === "object") {
    const e = (data as { error?: unknown }).error;
    if (typeof e === "string" && e.trim()) return e;
  }
  return `${fallback} (HTTP ${status}).`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function validSigma(v: unknown): [number, number, number] {
  const d = DEFAULT_SCREENING_OPTIONS.sigmaRicKm;
  if (!Array.isArray(v) || v.length !== 3) return [d[0], d[1], d[2]];
  return [0, 1, 2].map((k) => (isFiniteNumber(v[k]) && v[k] > 0 ? v[k] : d[k])) as [
    number,
    number,
    number,
  ];
}

/* ------------------------------------------------------------
   Presentational pieces
   ------------------------------------------------------------ */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  testId,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2 py-1 font-mono text-[0.65rem] tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        active
          ? "border-safe/60 bg-safe/15 text-safe"
          : "border-glass bg-white/5 text-text-secondary hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Hovered / focused cell, by key. The cell itself is looked up in the
 * CURRENT trade space at render, so a clock tick (new feasibility)
 * neither closes the tooltip nor leaves it showing stale flags.
 */
interface CellHover {
  key: string;
  left: number;
  top: number;
}

function CellTooltip({
  cell: c,
  left,
  top,
  baselineMissKm,
  thresholdPc,
}: {
  cell: TradeCell;
  left: number;
  top: number;
  baselineMissKm: number;
  thresholdPc: number;
}) {
  const flags: string[] = [];
  if (c.tooLate) flags.push("burn would have to start before now");
  else if (!c.feasible) flags.push("burn does not finish before TCA");
  if (!c.impulsiveOk && c.feasible) flags.push("long burn (≥10 % of an orbit) — finite-arc model");
  if (isTwoBodyRejected(c)) {
    flags.push(
      c.twoBody
        ? "clears the rule under CW only — fails it on two-body arcs, never recommended"
        : "two-body re-solve failed — never recommended"
    );
  }
  return (
    <div
      className="pointer-events-none absolute z-20 w-48 -translate-x-1/2 rounded-md border border-glass px-2 py-1.5 font-mono text-[0.6rem] leading-relaxed text-text-secondary shadow-lg"
      style={{ left, top, backgroundColor: "rgba(0,0,8,0.95)" }}
    >
      <div className="text-text-primary">
        {c.direction} {fmtSignedDv(c)} · TCA−{fmtLead(c.leadSeconds)}
      </div>
      <div>
        miss <span className="text-text-primary">{fmtFixed(c.missKm, 3)} km</span> (from{" "}
        {fmtFixed(baselineMissKm, 3)})
      </div>
      <div>
        Pc{" "}
        <span
          className="text-text-primary"
          style={{ color: c.pc >= thresholdPc ? COLOR_CAUTION : undefined }}
        >
          {fmtPc(c.pc, 2)}
        </span>
      </div>
      <div>Δr at TCA {fmtRic(c.ricKm, 3)}</div>
      <div>
        propellant {fmtPropellant(c.propellantKg)} · burn {fmtBurn(c.burnSeconds)}
      </div>
      {c.twoBody && (
        <div>
          two-body re-solve: miss{" "}
          <span className="text-text-primary">{fmtFixed(c.twoBody.missKm, 3)} km</span>, Pc{" "}
          <span
            className="text-text-primary"
            style={{ color: c.twoBody.pc >= thresholdPc ? COLOR_CAUTION : undefined }}
          >
            {fmtPc(c.twoBody.pc, 2)}
          </span>
        </div>
      )}
      {Math.abs(c.tcaShiftSeconds) >= 0.05 && (
        <div>TCA shift {fmtSigned(c.tcaShiftSeconds, 1)} s</div>
      )}
      {flags.map((f) => (
        <div key={f} style={{ color: COLOR_CAUTION }}>
          {f}
        </div>
      ))}
    </div>
  );
}

/* ---- Pc sensitivity mini chart ---- */

function SensitivityChart({
  points,
  dilution,
  thresholdPc,
}: {
  points: PcSensitivityPoint[];
  dilution: PcDilution;
  thresholdPc: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const W = 320;
  const H = 150;
  const ML = 38;
  const MR = 10;
  const MT = 10;
  const MB = 22;

  const logs = points.map((p) => Math.log10(Math.max(p.pc, PC_FLOOR)));
  const yLo = Math.max(-15, Math.min(-6, Math.floor(Math.min(...logs))));
  const yHi = Math.min(0, Math.max(-3, Math.ceil(Math.max(...logs))));
  const lx = points.map((p) => Math.log2(p.scale));
  const lx0 = Math.min(...lx);
  const lx1 = Math.max(...lx);
  const xs = (l2: number) => ML + ((l2 - lx0) / (lx1 - lx0 || 1)) * (W - ML - MR);
  const ys = (lg: number) => MT + ((yHi - lg) / (yHi - yLo || 1)) * (H - MT - MB);

  const decadeStep = Math.max(1, Math.ceil((yHi - yLo) / 4));
  const ticks: number[] = [];
  for (let t = yHi; t >= yLo; t -= decadeStep) ticks.push(t);

  const thresholdLg = Math.log10(thresholdPc);
  const redLg = Math.log10(ISS_PC_RED_THRESHOLD);
  const peakX =
    dilution.peakScale > 0 ? Math.min(Math.max(Math.log2(dilution.peakScale), lx0), lx1) : lx0;

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Pc versus covariance scale">
        {/* Dilution region (scales above the peak) — subtle status shading */}
        {dilution.diluted && (
          <rect
            x={xs(peakX)}
            y={MT}
            width={Math.max(0, W - MR - xs(peakX))}
            height={H - MT - MB}
            fill="rgba(255,184,0,0.06)"
          />
        )}
        {/* Decade gridlines + labels (single axis) */}
        <g className="text-text-secondary">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={ML} x2={W - MR} y1={ys(t)} y2={ys(t)} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              <text x={ML - 4} y={ys(t) + 3} textAnchor="end" fontSize={8} fill="currentColor" fontFamily="monospace">
                {`1e${t}`}
              </text>
            </g>
          ))}
          {points.map((p, i) => (
            <text
              key={p.scale}
              x={xs(lx[i])}
              y={H - 6}
              textAnchor="middle"
              fontSize={8}
              fill="currentColor"
              fontFamily="monospace"
            >
              {`${p.scale}×`}
            </text>
          ))}
        </g>
        {/* Threshold lines (status colours) */}
        {thresholdLg >= yLo && thresholdLg <= yHi && (
          <line x1={ML} x2={W - MR} y1={ys(thresholdLg)} y2={ys(thresholdLg)} stroke={COLOR_CAUTION} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
        )}
        {redLg >= yLo && redLg <= yHi && (
          <line x1={ML} x2={W - MR} y1={ys(redLg)} y2={ys(redLg)} stroke={COLOR_DANGER} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
        )}
        {/* Data line */}
        <polyline
          points={points.map((p, i) => `${xs(lx[i])},${ys(logs[i])}`).join(" ")}
          fill="none"
          stroke={COLOR_DATA}
          strokeWidth={1.5}
        />
        {points.map((p, i) => {
          const nominal = p.scale === 1;
          const floored = p.pc < PC_FLOOR;
          return (
            <circle
              key={p.scale}
              cx={xs(lx[i])}
              cy={ys(logs[i])}
              r={nominal ? 3.5 : 2.5}
              fill={floored ? "none" : COLOR_DATA}
              stroke={nominal ? "#E0E0E0" : COLOR_DATA}
              strokeWidth={nominal ? 1.2 : 1}
            />
          );
        })}
        {/* Hover zones */}
        {points.map((p, i) => {
          const left = i === 0 ? ML : (xs(lx[i - 1]) + xs(lx[i])) / 2;
          const right = i === points.length - 1 ? W - MR : (xs(lx[i]) + xs(lx[i + 1])) / 2;
          return (
            <rect
              key={p.scale}
              x={left}
              y={MT}
              width={Math.max(0, right - left)}
              height={H - MT - MB}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
            />
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6rem] text-text-muted">
        <span>
          <span style={{ color: COLOR_CAUTION }}>- - -</span> {fmtPc(thresholdPc, 0)} decision rule
        </span>
        <span>
          <span style={{ color: COLOR_DANGER }}>- - -</span> {fmtPc(ISS_PC_RED_THRESHOLD, 0)} NASA ISS red
        </span>
        <span>σ scale × (covariance × scale²) · ◯ nominal</span>
      </div>
      {hovered && hoverIdx !== null && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-glass px-2 py-1 font-mono text-[0.6rem] text-text-secondary"
          style={{
            left: `${(xs(lx[hoverIdx]) / W) * 100}%`,
            top: 0,
            backgroundColor: "rgba(0,0,8,0.95)",
          }}
        >
          σ × {hovered.scale} · Pc{" "}
          <span className="text-text-primary">
            {hovered.pc < PC_FLOOR ? `<${fmtPc(PC_FLOOR, 0)}` : fmtPc(hovered.pc, 2)}
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   Panel
   ------------------------------------------------------------ */

interface RunRequest {
  target: string;
  hours: number;
  nonce: number;
}

interface GridState {
  grid: TradeGrid | null;
  error: string | null;
}

export default function AvoidancePlanner() {
  const [targetInput, setTargetInput] = useState(DEFAULT_TARGET);
  const [hours, setHours] = useState<number>(DEFAULT_HOURS);
  const [run, setRun] = useState<RunRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<ScreeningResult | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [vehicleId, setVehicleId] = useState<string>(VEHICLE_PRESETS[0].id);
  const [direction, setDirection] = useState<BurnDirection>("PROGRADE");
  const [hover, setHover] = useState<CellHover | null>(null);

  // Wall clock for "time remaining until TCA" — initialised in an effect.
  const [nowMs, setNowMs] = useState<number | null>(null);

  const gridWrapRef = useRef<HTMLDivElement | null>(null);

  /* ---- Clock: only while there is something to plan ---- */
  useEffect(() => {
    if (!result) {
      setNowMs(null);
      return;
    }
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [result]);

  /* ---- Fetcher ---- */
  const fetchScreen = useCallback(
    async (target: string, windowHours: number, signal: AbortSignal): Promise<ScreeningResult> => {
      const url = `/api/screen?target=${encodeURIComponent(target)}&hours=${windowHours}`;
      const res = await timedFetch(url, { signal });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error(errorMessage(data, res.status, "Screening request failed"));
      if (
        !data ||
        typeof data !== "object" ||
        !Array.isArray((data as ScreeningResult).closeApproaches)
      ) {
        throw new Error("Screening response was malformed.");
      }
      return data as ScreeningResult;
    },
    []
  );

  /* ---- Screening run ---- */
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    const controller = new AbortController();
    setRunning(true);
    setRunError(null);
    setResult(null);
    setSelectedKey(null);
    setHover(null);

    (async () => {
      try {
        const data = await fetchScreen(run.target, run.hours, controller.signal);
        if (cancelled) return;
        setResult(data);
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        setRunError(err instanceof Error ? err.message : "Screening failed.");
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [run, fetchScreen]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (running) return;
    const target = targetInput.trim();
    if (!target) {
      setRunError("Enter a satellite name or NORAD ID.");
      return;
    }
    setRun((prev) => ({ target, hours, nonce: (prev?.nonce ?? 0) + 1 }));
  }

  /* ---- Events: the 5 highest-Pc approaches (ties → closest) ---- */
  const events = useMemo<ScreeningCloseApproach[]>(() => {
    if (!result) return [];
    const pcOf = (e: ScreeningCloseApproach): number =>
      isFiniteNumber(e.probabilityOfCollision) ? e.probabilityOfCollision : 0;
    return result.closeApproaches
      .filter((e) => e && typeof e === "object" && isFiniteNumber(e.missDistanceKm))
      .sort((a, b) => pcOf(b) - pcOf(a) || a.missDistanceKm - b.missDistanceKm)
      .slice(0, MAX_EVENTS);
  }, [result]);

  const defaultEvent = useMemo<ScreeningCloseApproach | null>(() => {
    let best: ScreeningCloseApproach | null = null;
    for (const e of events) {
      const pc = isFiniteNumber(e.probabilityOfCollision) ? e.probabilityOfCollision : 0;
      const bestPc = best && isFiniteNumber(best.probabilityOfCollision) ? best.probabilityOfCollision : 0;
      if (!best || pc > bestPc) best = e;
    }
    return best;
  }, [events]);

  const selected = useMemo<ScreeningCloseApproach | null>(
    () => events.find((e) => eventKey(e) === selectedKey) ?? defaultEvent,
    [events, selectedKey, defaultEvent]
  );

  const states = useMemo<{ target: StateVector; secondary: StateVector } | null>(() => {
    if (!selected) return null;
    const t = selected.targetStateEci;
    const s = selected.secondaryStateEci;
    if (!isUsableState(t) || !isUsableState(s)) return null;
    return { target: t, secondary: s };
  }, [selected]);

  const sigma = useMemo(() => validSigma(result?.assumptions?.sigmaRicKm), [result]);
  const hbrM =
    isFiniteNumber(result?.assumptions?.hardBodyRadiusM) && result.assumptions.hardBodyRadiusM > 0
      ? result.assumptions.hardBodyRadiusM
      : DEFAULT_SCREENING_OPTIONS.hardBodyRadiusM;

  const vehicle = VEHICLE_PRESETS.find((v) => v.id === vehicleId) ?? VEHICLE_PRESETS[0];

  const tcaMs = parseIso(selected?.tca)?.getTime() ?? null;
  const secondsToTca = tcaMs !== null && nowMs !== null ? (tcaMs - nowMs) / 1000 : null;
  const tcaPassed = secondsToTca !== null && secondsToTca <= 0;
  const availableSeconds = secondsToTca !== null && secondsToTca > 0 ? secondsToTca : null;
  const clockReady = nowMs !== null;

  /* ---- Decision rule: NASA's ISS red line for the ISS, Starlink's trigger otherwise ---- */
  const isIssTarget = result?.target?.noradId === ISS_NORAD_ID;
  const thresholdPc = isIssTarget ? ISS_PC_RED_THRESHOLD : STARLINK_PC_MANEUVER_THRESHOLD;
  const ruleLabel = isIssTarget ? "NASA ISS red line" : "Starlink";

  /* ---- Trade space: expensive CW grid (per event / vehicle / covariance) ---- */
  const gridState = useMemo<GridState>(() => {
    if (!states) return { grid: null, error: null };
    try {
      const grid = evaluateTradeGrid({
        targetState: states.target,
        secondaryState: states.secondary,
        sigmaRicKm: sigma,
        hardBodyRadiusM: hbrM,
        vehicle,
        thresholdPc,
      });
      return { grid, error: null };
    } catch (err) {
      return { grid: null, error: err instanceof Error ? err.message : "Planning failed." };
    }
  }, [states, sigma, hbrM, vehicle, thresholdPc]);
  const grid = gridState.grid;

  /* ---- ...then the cheap, time-dependent part (every clock tick) ---- */
  const ts = useMemo<TradeSpace | null>(
    () => (grid && clockReady ? finalizeTradeSpace(grid, availableSeconds) : null),
    [grid, clockReady, availableSeconds]
  );
  const rec = ts?.recommended ?? null;
  const recTruth = ts?.recommendedTwoBody ?? null;
  const showStar = Boolean(ts && rec && ts.maneuverRequired);

  // Follow the recommended burn's direction so its ★ is on screen.
  const recDirKey = showStar && rec && selected ? `${eventKey(selected)}|${vehicleId}|${rec.direction}` : null;
  const recDirection = showStar && rec ? rec.direction : null;
  useEffect(() => {
    if (recDirKey && recDirection) setDirection(recDirection);
  }, [recDirKey, recDirection]);

  /* ---- Live linearisation check (encounter plane + eccentricity) ---- */
  const linRefDvMps = rec?.dvMps ?? CW_CHECK_REFERENCE_DV_MPS;
  const linearisation = useMemo<LinearisationCheck | null>(() => {
    if (!states) return null;
    return checkLinearisation(states.target, states.secondary, linRefDvMps);
  }, [states, linRefDvMps]);

  /* ---- Pc sensitivity ---- */
  const sensitivity = useMemo<{ points: PcSensitivityPoint[]; dilution: PcDilution } | null>(() => {
    if (!states) return null;
    const points = pcSensitivity(states.target, states.secondary, sigma, hbrM);
    if (points.length < 2) return null;
    return { points, dilution: pcDilution(states.target, states.secondary, sigma, hbrM) };
  }, [states, sigma, hbrM]);

  /* ---- Grid lookup ---- */
  const cellMap = useMemo(() => {
    const m = new Map<string, TradeCell>();
    if (ts) for (const c of ts.cells) m.set(tradeCellKey(c), c);
    return m;
  }, [ts]);

  const showTooltip = useCallback(
    (cell: TradeCell, e: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>) => {
      const wrap = gridWrapRef.current;
      if (!wrap) return;
      const wr = wrap.getBoundingClientRect();
      const cr = e.currentTarget.getBoundingClientRect();
      const half = 96; // half of w-48
      const rawLeft = cr.left - wr.left + cr.width / 2;
      const left = Math.min(Math.max(rawLeft, half), Math.max(half, wr.width - half));
      setHover({ key: tradeCellKey(cell), left, top: cr.bottom - wr.top + 4 });
    },
    []
  );

  const hideTooltip = useCallback(() => setHover(null), []);

  // A new direction, event, vehicle or covariance (a new grid) closes any
  // open tooltip. A clock tick does not: the tooltip re-reads its cell.
  useEffect(() => {
    setHover(null);
  }, [direction, grid]);
  const hoverCell = hover ? cellMap.get(hover.key) ?? null : null;

  const truncated = result?.truncated === true;
  const reportKm = isFiniteNumber(result?.assumptions?.reportThresholdKm)
    ? result.assumptions.reportThresholdKm
    : DEFAULT_SCREENING_OPTIONS.reportThresholdKm;
  const thresholdLabel = fmtPc(thresholdPc, 0);
  /** Below NASA's red line an amber band exists between the two thresholds. */
  const amberBand = thresholdPc < ISS_PC_RED_THRESHOLD;
  const earliestLead = Math.max(...DEFAULT_LEADS_SECONDS);

  return (
    <section className="glass-card overflow-hidden" data-testid="avoidance-planner">
      {/* Header */}
      <div className="flex h-9 items-center justify-between border-b border-glass px-3">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          AVOIDANCE BURN PLANNER
        </h2>
        <span className="hidden truncate pl-2 font-mono text-[0.65rem] text-text-muted sm:inline">
          decision rule: maneuver when Pc ≥ {thresholdLabel} ({ruleLabel})
        </span>
      </div>

      <div className="p-4">
        {/* ---- Controls ---- */}
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            data-testid="avoid-target"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            placeholder="Satellite name or NORAD ID"
            maxLength={64}
            spellCheck={false}
            className="min-w-[10rem] flex-1 rounded-md border border-glass bg-white/5 px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-safe focus:outline-none"
          />
          <div className="flex items-center gap-1">
            {WINDOW_OPTIONS.map((h) => (
              <ToggleButton
                key={h}
                active={h === hours}
                onClick={() => setHours(h)}
                testId={`avoid-hours-${h}`}
                disabled={running}
              >
                {h}h
              </ToggleButton>
            ))}
          </div>
          <button
            type="submit"
            data-testid="avoid-run"
            disabled={running}
            className="rounded border border-safe/60 bg-safe/15 px-3 py-1 font-mono text-[0.65rem] font-semibold tracking-wide text-safe transition-colors hover:bg-safe/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? "Screening…" : "RUN"}
          </button>
        </form>

        {/* ---- Vehicle presets ---- */}
        <div className="mt-3">
          <Label>Vehicle (propellant / burn time — public estimates)</Label>
          <div className="mt-1 flex flex-wrap gap-1">
            {VEHICLE_PRESETS.map((v) => (
              <ToggleButton
                key={v.id}
                active={v.id === vehicle.id}
                onClick={() => setVehicleId(v.id)}
                testId={`avoid-vehicle-${v.id}`}
              >
                {v.label}
              </ToggleButton>
            ))}
          </div>
          <div className="mt-1 font-mono text-[0.6rem] text-text-muted">
            {vehicle.wetMassKg.toLocaleString()} kg wet · Isp {vehicle.ispSeconds} s · thrust{" "}
            {vehicle.thrustNewtons} N · {vehicle.note}
          </div>
        </div>

        {/* ---- States ---- */}
        {running && run && (
          <div className="mt-3 font-mono text-xs text-text-secondary blink-cursor">
            Screening {run.target} over {run.hours} h for avoidance planning
          </div>
        )}

        {runError && (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {runError}
          </div>
        )}

        {!running && !runError && !result && (
          <div className="mt-3 font-mono text-xs text-text-muted">
            RUN screens the target with SGP4 (served from the screener&apos;s 5-min cache when the
            same target and window already ran), then plans a single avoidance burn for any of the
            5 highest-Pc approaches.
          </div>
        )}

        {result && (
          <div className="mt-4 flex flex-col gap-4">
            {truncated && (
              <div className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 font-mono text-xs text-caution">
                Screen hit its compute budget — only {fmtFixed(result.candidatesScreened, 0)} candidates
                were screened; rerun with a shorter window for full coverage.
              </div>
            )}

            {/* The vehicle presets are Starlink-class, and so is the default rule.
                Say so when the screened target is something else, so this panel is
                never read as a go/no-go call with the wrong rule or the wrong mass. */}
            {result.target && events.length > 0 && !/STARLINK/i.test(result.target.name) && (
              <div
                className="rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-xs text-text-muted"
                data-testid="avoid-illustration-note"
              >
                {isIssTarget ? (
                  <>
                    NASA&apos;s ISS rule decides here (maneuver at Pc ≥ {thresholdLabel}, RED in the ISS
                    console above). The propellant and burn-time columns are for the selected
                    Starlink-class preset, not the ~420 t ISS.
                  </>
                ) : (
                  <>
                    Starlink&apos;s decision rule (Pc ≥ {thresholdLabel}) and vehicle presets are applied
                    to <span className="text-text-secondary">{result.target.name}</span> for illustration
                    only.
                  </>
                )}
              </div>
            )}

            {events.length === 0 ? (
              <div className="rounded-md border border-safe/40 bg-safe/10 px-3 py-2 font-mono text-xs text-text-primary">
                No close approaches within {fmtFixed(reportKm, 0)} km of{" "}
                {result.target?.name || run?.target || "the target"} in this window — nothing to plan.
              </div>
            ) : (
              <>
                {/* ---- Event picker ---- */}
                <div>
                  <Label>
                    Close approach ({result.target?.name || run?.target || "target"} · top {events.length} by Pc)
                  </Label>
                  <select
                    data-testid="avoid-event"
                    value={selected ? eventKey(selected) : ""}
                    onChange={(e) => setSelectedKey(e.target.value)}
                    className="mt-1 w-full rounded-md border border-glass bg-white/5 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-safe focus:outline-none"
                  >
                    {events.map((e) => (
                      <option key={eventKey(e)} value={eventKey(e)} className="bg-space text-text-primary">
                        {`${e.name || `NORAD ${e.noradId}`} · ${fmtFixed(e.missDistanceKm, 2)} km · Pc ${fmtPc(
                          e.probabilityOfCollision,
                          1
                        )}`}
                      </option>
                    ))}
                  </select>
                </div>

                {selected && !states && (
                  <div
                    data-testid="avoid-no-states"
                    className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 font-mono text-xs text-caution"
                  >
                    State vectors unavailable — rerun the screen.
                  </div>
                )}

                {gridState.error && (
                  <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
                    {gridState.error}
                  </div>
                )}

                {ts && selected && (
                  <>
                    {/* ---- Recommendation + baseline ---- */}
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div
                        data-testid="avoid-recommendation"
                        className="rounded-md border px-3 py-2 font-mono text-xs"
                        style={{
                          borderColor: !ts.maneuverRequired
                            ? "rgba(0,255,65,0.4)"
                            : rec
                              ? "rgba(0,255,65,0.6)"
                              : "rgba(255,49,49,0.6)",
                          backgroundColor: !ts.maneuverRequired || rec ? "rgba(0,255,65,0.06)" : "rgba(255,49,49,0.08)",
                        }}
                      >
                        <Label>Decision</Label>
                        {!ts.maneuverRequired ? (
                          <>
                            <div className="mt-1 leading-relaxed" style={{ color: COLOR_SAFE }}>
                              NO MANEUVER REQUIRED — baseline Pc {fmtPc(ts.baseline.pc, 1)} is below the{" "}
                              {thresholdLabel} decision threshold.
                            </div>
                            {rec && (
                              <div className="mt-1 text-[0.65rem] leading-relaxed text-text-muted">
                                For reference, the cheapest burn that also widens the miss: {rec.direction}{" "}
                                {fmtSignedDv(rec)} at TCA−{fmtLead(rec.leadSeconds)} → miss{" "}
                                {fmtFixed(rec.missKm, 2)} km, propellant {fmtPropellant(rec.propellantKg)} (as
                                the {vehicle.label} preset).
                              </div>
                            )}
                          </>
                        ) : rec ? (
                          <>
                            <div className="mt-1 leading-relaxed" style={{ color: COLOR_SAFE }}>
                              RECOMMENDED: {rec.direction} {fmtSignedDv(rec)} at TCA−{fmtLead(rec.leadSeconds)} → miss{" "}
                              {fmtFixed(rec.missKm, 2)} km (from {fmtFixed(ts.baseline.missKm, 2)}), Pc{" "}
                              {fmtPc(rec.pc, 1)} (from {fmtPc(ts.baseline.pc, 1)}), propellant{" "}
                              {fmtPropellant(rec.propellantKg)}, burn {fmtBurn(rec.burnSeconds)} (as the{" "}
                              {vehicle.label} preset — public estimates)
                            </div>
                            {recTruth && (
                              <div
                                data-testid="avoid-two-body-confirmed"
                                className="mt-1 text-[0.65rem] leading-relaxed text-text-secondary"
                              >
                                <span style={{ color: COLOR_SAFE }}>✓</span> Confirmed on two-body arcs (no
                                linearisation): miss{" "}
                                <span className="text-text-primary">{fmtFixed(recTruth.missKm, 2)} km</span>, Pc{" "}
                                <span className="text-text-primary">{fmtPc(recTruth.pc, 1)}</span> — also below{" "}
                                {thresholdLabel}.
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="mt-1 font-bold leading-relaxed" style={{ color: COLOR_DANGER }}>
                            NO SINGLE-BURN SOLUTION in the trade space — escalate
                          </div>
                        )}
                        {ts.twoBodyRejected > 0 && (
                          <div className="mt-1 text-[0.65rem] leading-relaxed" style={{ color: COLOR_CAUTION }}>
                            {ts.twoBodyRejected} {rec ? "higher-preference " : ""}CW candidate
                            {ts.twoBodyRejected === 1 ? "" : "s"} cleared the rule under the linearised model but
                            failed it when re-solved on two-body arcs ({ts.twoBodyRejected === 1 ? "is" : "are"}{" "}
                            marked ✗ in the grid and never recommended).
                          </div>
                        )}
                        {ts.maneuverRequired && !rec && ts.availableSeconds !== null && ts.availableSeconds < earliestLead && (
                          <div className="mt-1 text-[0.65rem] text-text-muted">
                            Only {formatDuration(ts.availableSeconds * 1000)} remain before TCA — earlier burn leads are no longer available.
                          </div>
                        )}
                      </div>

                      <div className="rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-xs">
                        <Label>Baseline (no maneuver)</Label>
                        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-text-secondary">
                          <span>
                            miss <span className="text-text-primary">{fmtFixed(ts.baseline.missKm, 3)} km</span>
                          </span>
                          <span>
                            Pc{" "}
                            <span
                              className="text-text-primary"
                              style={{ color: ts.maneuverRequired ? COLOR_CAUTION : undefined }}
                            >
                              {fmtPc(ts.baseline.pc, 2)}
                            </span>
                          </span>
                          <span>
                            v<sub>rel</sub>{" "}
                            <span className="text-text-primary">{fmtFixed(ts.baseline.relativeSpeedKmS, 2)} km/s</span>
                          </span>
                          <span>
                            TCA{" "}
                            <span className="text-text-primary">
                              {tcaMs !== null ? formatUtc(new Date(tcaMs)) : "—"}
                            </span>
                          </span>
                        </div>
                        <div className="mt-0.5 text-[0.65rem] text-text-secondary">
                          RIC <span className="text-text-primary">{fmtRic(ts.baseline.ricKm, 3)}</span>
                        </div>
                        <div className="mt-0.5 text-[0.6rem] text-text-muted">
                          {selected.name || `NORAD ${selected.noradId}`} · {selected.objectClass || "UNKNOWN"}
                          {secondsToTca !== null &&
                            (secondsToTca > 0
                              ? ` · TCA in ${formatDuration(secondsToTca * 1000)}`
                              : ` · TCA ${formatDuration(-secondsToTca * 1000)} ago`)}
                          {` · period ${fmtFixed(ts.periodSeconds / 60, 1)} min`}
                        </div>
                        {isFiniteNumber(selected.missDistanceKm) &&
                          Math.abs(selected.missDistanceKm - ts.baseline.missKm) >
                            Math.max(0.01, 0.02 * ts.baseline.missKm) && (
                            <div data-testid="avoid-miss-resolve" className="mt-0.5 text-[0.6rem] text-text-muted">
                              Screen miss {fmtFixed(selected.missDistanceKm, 3)} km at its sampled TCA; the
                              straight-line closest approach of the same states is {fmtFixed(ts.baseline.missKm, 3)} km
                              ({fmtSigned(ts.baseline.tcaOffsetSeconds, 3)} s) — the planner uses the latter.
                            </div>
                          )}
                        {ts.coOrbital && (
                          <div className="mt-0.5 text-[0.6rem]" style={{ color: COLOR_CAUTION }}>
                            Co-orbital encounter (v<sub>rel</sub> &lt; 0.1 km/s): straight-line Pc and miss are indicative only.
                          </div>
                        )}
                      </div>
                    </div>

                    {tcaPassed && (
                      <div className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 font-mono text-xs text-caution">
                        TCA has passed — trade space shown for illustration (no time-remaining constraint applied).
                      </div>
                    )}

                    {/* ---- Linearisation check ---- */}
                    <div data-testid="avoid-verification" className="font-mono text-[0.65rem] leading-relaxed text-text-secondary">
                      {linearisation === null ? (
                        <span className="text-text-muted">
                          Linearisation check unavailable for this geometry — the recommendation still
                          requires a two-body re-solve.
                        </span>
                      ) : linearisation.valid ? (
                        <>
                          Linearisation verified against two-body: max error{" "}
                          <span className="text-text-primary">
                            {fmtPercent(linearisation.maxEncounterPlaneError)} %
                          </span>{" "}
                          in the encounter plane (3-D {fmtPercent(linearisation.maxError3d)} %;{" "}
                          {linearisation.cases} impulsive burns of ±{fmtCmPerS(linearisation.referenceDvMps)} cm/s,
                          every lead; osculating e = {fmtEcc(linearisation.eccentricity)})
                        </>
                      ) : (
                        <span data-testid="avoid-linearisation-invalid" style={{ color: COLOR_CAUTION }}>
                          CW linearisation outside its {Math.round(CW_VALID_MAX_ERROR * 1000) / 10} % envelope for this
                          orbit: encounter-plane error {fmtPercent(linearisation.maxEncounterPlaneError)} % (3-D{" "}
                          {fmtPercent(linearisation.maxError3d)} %) over {linearisation.cases} impulsive burns of ±
                          {fmtCmPerS(linearisation.referenceDvMps)} cm/s, osculating e ={" "}
                          {fmtEcc(linearisation.eccentricity)}
                          {Number.isFinite(linearisation.eccentricity) &&
                          linearisation.eccentricity > CW_VALID_MAX_ECCENTRICITY
                            ? ` (> ${CW_VALID_MAX_ECCENTRICITY} — CW assumes a circular reference orbit)`
                            : ""}
                          . Heat-map miss / Pc values are indicative only; a burn is recommended only after
                          a two-body re-solve confirms it.
                        </span>
                      )}
                      {rec && recTruth && (
                        <>
                          {" "}· recommended burn re-solved on two-body arcs (no linearisation): miss{" "}
                          <span className="text-text-primary">{fmtFixed(recTruth.missKm, 3)} km</span> (CW{" "}
                          {fmtFixed(rec.missKm, 3)}), Pc{" "}
                          <span className="text-text-primary">{fmtPc(recTruth.pc, 1)}</span> (CW {fmtPc(rec.pc, 1)})
                        </>
                      )}
                    </div>

                    {/* ---- Trade space heat map ---- */}
                    <div data-testid="avoid-tradespace">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <Label>
                          Trade space · cell = miss km after the burn · colour = Pc
                        </Label>
                        <div className="flex items-center gap-1">
                          {(["PROGRADE", "RETROGRADE"] as const).map((d) => (
                            <ToggleButton
                              key={d}
                              active={direction === d}
                              onClick={() => setDirection(d)}
                              testId={`avoid-dir-${d}`}
                            >
                              {d}
                              {showStar && rec?.direction === d ? " ★" : ""}
                            </ToggleButton>
                          ))}
                        </div>
                      </div>

                      <div className="relative" ref={gridWrapRef}>
                        <div className="overflow-x-auto">
                          <div
                            className="grid min-w-[18rem] gap-[2px]"
                            style={{
                              gridTemplateColumns: `minmax(3.2rem, auto) repeat(${ts.dvs.length}, minmax(2.1rem, 1fr))`,
                            }}
                          >
                            <div className="px-1 py-1 font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">
                              lead \ cm/s
                            </div>
                            {ts.dvs.map((dv) => (
                              <div
                                key={dv}
                                className="px-1 py-1 text-center font-mono text-[0.6rem] text-text-secondary"
                              >
                                {fmtCmPerS(dv)}
                              </div>
                            ))}
                            {ts.leads.map((lead) => (
                              <LeadRow
                                key={lead}
                                lead={lead}
                                dvs={ts.dvs}
                                direction={direction}
                                cellMap={cellMap}
                                thresholdPc={ts.thresholdPc}
                                recommended={showStar ? rec : null}
                                onShow={showTooltip}
                                onHide={hideTooltip}
                              />
                            ))}
                          </div>
                        </div>
                        {hover && hoverCell && (
                          <CellTooltip
                            cell={hoverCell}
                            left={hover.left}
                            top={hover.top}
                            baselineMissKm={ts.baseline.missKm}
                            thresholdPc={ts.thresholdPc}
                          />
                        )}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.6rem] text-text-muted">
                        <Swatch color={BG_RED} label={`Pc ≥ ${fmtPc(ISS_PC_RED_THRESHOLD, 0)}`} />
                        {amberBand && (
                          <Swatch color={BG_AMBER} label={`${thresholdLabel} ≤ Pc < ${fmtPc(ISS_PC_RED_THRESHOLD, 0)}`} />
                        )}
                        <Swatch color={BG_GREEN} label={`Pc < ${thresholdLabel}`} />
                        <span className="flex items-center gap-1">
                          <span
                            className="inline-block h-2.5 w-3.5 rounded-sm"
                            style={{ backgroundImage: HATCH, backgroundColor: "rgba(255,255,255,0.04)" }}
                          />
                          infeasible (too late / burn too long)
                        </span>
                        {showStar && <span style={{ color: COLOR_SAFE }}>★ recommended (two-body confirmed)</span>}
                        {ts.twoBodyRejected > 0 && (
                          <span style={{ color: COLOR_CAUTION }}>✗ clears the rule under CW only — fails it on two-body arcs</span>
                        )}
                        <span>burn centred at TCA − lead</span>
                      </div>
                    </div>

                    {/* ---- Pc sensitivity ---- */}
                    {sensitivity && (
                      <div data-testid="avoid-sensitivity" className="rounded-md border border-glass bg-white/5 p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <Label>Pc sensitivity to the assumed covariance (log₁₀ Pc vs σ scale)</Label>
                          {sensitivity.dilution.diluted && (
                            <span
                              data-testid="avoid-dilution"
                              className="rounded px-2 py-0.5 font-display text-[0.6rem] font-bold"
                              style={{ color: COLOR_CAUTION, border: `1px solid ${COLOR_CAUTION}` }}
                            >
                              DILUTION REGION
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] md:items-center">
                          <SensitivityChart
                            points={sensitivity.points}
                            dilution={sensitivity.dilution}
                            thresholdPc={ts.thresholdPc}
                          />
                          <div className="font-mono text-[0.65rem] leading-relaxed text-text-secondary">
                            {sensitivity.dilution.diluted ? (
                              sensitivity.dilution.nominalPc >= ts.thresholdPc ? (
                                <>
                                  A larger covariance LOWERS Pc here — this encounter sits in the dilution
                                  region, so the already-actionable Pc is if anything optimistic: with better
                                  tracking (σ × {fmtFixed(sensitivity.dilution.peakScale, 2)}) it would rise to{" "}
                                  {fmtPc(sensitivity.dilution.peakPc, 1)}.
                                </>
                              ) : (
                                <>
                                  A larger covariance LOWERS Pc here — the low number reflects uncertainty, not
                                  safety: with better tracking (σ × {fmtFixed(sensitivity.dilution.peakScale, 2)})
                                  Pc would peak at {fmtPc(sensitivity.dilution.peakPc, 1)}.
                                </>
                              )
                            ) : (
                              <>
                                Pc rises with the covariance at nominal (peak at σ ×{" "}
                                {fmtFixed(sensitivity.dilution.peakScale, 1)}) — not in the dilution region; the
                                number is driven by the miss geometry, not by uncertainty.
                              </>
                            )}
                            <div className="mt-1 text-text-muted">
                              σ scale multiplies every 1-σ value of both objects (covariance × scale²);
                              1× is the screen&apos;s assumed TLE-grade covariance.
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* ---- Footnote ---- */}
            <div className="border-t border-glass pt-2 font-mono text-[0.6rem] leading-relaxed text-text-muted">
              Clohessy-Wiltshire linearised relative motion on a circular reference orbit, verified
              against two-body propagation (in the encounter plane; &quot;verified&quot; only within{" "}
              {Math.round(CW_VALID_MAX_ERROR * 1000) / 10} % and e ≤ {CW_VALID_MAX_ECCENTRICITY}, otherwise the
              heat map is indicative only); a burn is recommended only when a two-body re-solve with no
              linearisation also clears the decision rule; Pc under the screen&apos;s assumed TLE-grade covariance
              (σ RIC {fmtFixed(sigma[0], 1)} / {fmtFixed(sigma[1], 1)} / {fmtFixed(sigma[2], 1)} km per
              object, HBR {fmtFixed(hbrM, 0)} m); vehicle mass / Isp / thrust are public estimates. In-track
              burns only, centred on the lead time and modelled as finite constant-thrust arcs (
              {FINITE_BURN_SUBSTEPS}-impulse CW superposition); miss = closest approach under straight-line
              relative motion; propellant and burn time treat the screened target as the selected vehicle;
              the secondary does not maneuver; J2 / drag differential effects are not modelled. A planning
              aid — not flight software, not an operator product.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------
   Heat-map row + legend swatch
   ------------------------------------------------------------ */

function LeadRow({
  lead,
  dvs,
  direction,
  cellMap,
  thresholdPc,
  recommended,
  onShow,
  onHide,
}: {
  lead: number;
  dvs: number[];
  direction: BurnDirection;
  cellMap: Map<string, TradeCell>;
  thresholdPc: number;
  recommended: TradeCell | null;
  onShow: (cell: TradeCell, e: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>) => void;
  onHide: () => void;
}) {
  return (
    <>
      <div className="flex items-center px-1 font-mono text-[0.6rem] text-text-secondary">
        TCA−{fmtLead(lead)}
      </div>
      {dvs.map((dv) => {
        const c = cellMap.get(`${lead}|${dv}|${direction}`);
        if (!c) {
          return (
            <div key={dv} className="rounded-sm bg-white/5 py-1.5 text-center font-mono text-[0.6rem] text-text-muted">
              —
            </div>
          );
        }
        const isRec =
          recommended !== null &&
          recommended.leadSeconds === c.leadSeconds &&
          recommended.dvMps === c.dvMps &&
          recommended.direction === c.direction;
        const rejected = !isRec && isTwoBodyRejected(c);
        return (
          <button
            key={dv}
            type="button"
            data-testid={`avoid-cell-${c.leadSeconds}-${fmtCmPerS(c.dvMps)}`}
            data-recommended={isRec ? "true" : undefined}
            data-two-body={rejected ? "rejected" : undefined}
            aria-label={`${c.direction} ${fmtSignedDv(c)} at TCA minus ${fmtLead(c.leadSeconds)}: miss ${fmtFixed(
              c.missKm,
              2
            )} km, Pc ${fmtPc(c.pc, 1)}${c.feasible ? "" : ", infeasible"}${isRec ? ", recommended" : ""}${
              rejected ? ", fails the two-body re-solve" : ""
            }`}
            onMouseEnter={(e) => onShow(c, e)}
            onFocus={(e) => onShow(c, e)}
            onMouseLeave={onHide}
            onBlur={onHide}
            className="rounded-sm py-1.5 text-center font-mono text-[0.6rem] text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary"
            style={{
              backgroundColor: cellBackground(c.pc, thresholdPc),
              backgroundImage: c.feasible ? undefined : HATCH,
              opacity: c.feasible ? 1 : 0.45,
              outline: isRec
                ? `2px solid ${COLOR_SAFE}`
                : rejected
                  ? `2px dashed ${COLOR_CAUTION}`
                  : undefined,
              outlineOffset: isRec || rejected ? "-2px" : undefined,
            }}
          >
            {isRec ? "★" : rejected ? "✗" : ""}
            {fmtCellMiss(c.missKm)}
          </button>
        );
      })}
    </>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-2.5 w-3.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
