"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { timedFetch } from "@/lib/telemetry";
import { formatDuration, formatUtc, formatUtcTime } from "@/lib/orbital";
import {
  ALT_BAND_KM,
  COLA_RED_KM,
  COLA_WINDOW_OPTIONS,
  COLA_YELLOW_KM,
  DOWNRANGE_DEG,
  INSERTION_DELAY_S,
  LAUNCH_SITES,
  SCREEN_AFTER_INSERTION_S,
  SCREEN_STEP_S,
  TARGET_ORBITS,
  ascentDirection,
  findLaunchSite,
  findTargetOrbit,
  orbitReachable,
  type ColaAssumptions,
  type ColaMinute,
  type ColaResult,
  type ColaStatus,
} from "@/lib/launch";

/* ============================================================
   Session 6 — Feature 3: Launch Collision-Avoidance (COLA) Screening

   Every Falcon 9 launch gets a COLA screen that blacks out launch
   times whose ascent / insertion would pass too close to a tracked
   object. This panel runs a SIMPLIFIED version of that screen live
   against the dashboard's catalog sample.

   Data flow
   - RUN SCREEN → GET /api/cola?site=&orbit=&minutes= through
     timedFetch (so System Telemetry sees the latency). The route
     screens every liftoff minute of the window (lib/launch.ts) and
     caches per site|orbit|minutes|start-minute for 5 min.
   - The panel runs ONE screen automatically the first time it
     scrolls into view (IntersectionObserver) with the current
     selection, so a visitor never lands on an empty panel; after
     that, screens are on demand only. No polling.
   - Fetching happens only inside the run effect (cancelled flag +
     AbortController); the IntersectionObserver and the tooltip's
     outside-tap listener are torn down on unmount.

   Rendering
   - Summary: GO / CAUTION / NO-GO minute counts + the next clear
     window (first run of consecutive GO liftoff minutes).
   - Timeline: one SVG rect per liftoff minute, status colours only
     (GO #00FF41 at 0.55 opacity, CAUTION #FFB800, NO-GO #FF3131,
     unscreened minutes grey), 30-min ticks with HTML labels, hover /
     tap tooltip (HTML div) with liftoff time, status, minimum miss,
     the offending object and its closest-approach time. The tooltip
     is measured after every hover change and clamped inside the
     timeline wrapper (the panel is overflow-hidden), so it is never
     clipped at either end on a phone.
   - Table of every CAUTION / NO-GO minute, stats line, footnote.
   - Zero candidates (empty sample, or nothing within the ±50 km
     band): the lib still grades every minute GO (nothing came close),
     but the panel does NOT present that as a clear window — counts
     read n/a, bars are grey, and a neutral notice says nothing was
     screened.

   ASSUMPTIONS (also printed on screen in the muted footnote)
   - Instantaneous insertion into the CIRCULAR target orbit at T+9
     min, 20° of orbital arc downrange; real vehicles insert lower and
     raise (Starlink deploys below its operational shell).
   - Orbit plane through the site at liftoff; Vandenberg flies south,
     retrograde (SSO) ascents fly the southbound corridor, others
     north.
   - Two-body coast for 20 min, SGP4 for the catalog objects, 30 s
     samples with straight-line closest-approach refinement inside
     each step.
   - Screened against the 2,000-object catalog sample only, by miss
     distance only (no covariance, no Pc). NO-GO < 5 km, CAUTION
     < 25 km. Engineering demonstration — not a launch-commit product.
   ============================================================ */

const DEFAULT_SITE_ID = "slc-40";
const DEFAULT_ORBIT_ID = "starlink-550";
const DEFAULT_WINDOW_MINUTES = 120;
const TICK_EVERY_MINUTES = 30;
const DRIVER_COUNT = 3;
const GLASS_BORDER = "rgba(255,255,255,0.08)";

const STATUS_COLORS: Record<ColaStatus, string> = {
  GO: "#00FF41",
  CAUTION: "#FFB800",
  "NO-GO": "#FF3131",
};
const STATUS_OPACITY: Record<ColaStatus, number> = {
  GO: 0.55,
  CAUTION: 1,
  "NO-GO": 1,
};
const UNSCREENED_FILL = "rgba(255,255,255,0.08)";

/* ---- Timeline geometry (viewBox units) ---- */
const VB_W = 400;
const VB_H = 40;
const BAR_Y = 3;
const BAR_H = 27;
const TICK_Y0 = 32;
const TICK_Y1 = 37;

/* ------------------------------------------------------------
   Formatting helpers — never render NaN / undefined / Invalid Date
   ------------------------------------------------------------ */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseIsoMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function fmtHm(ms: number | null): string {
  if (ms === null) return "—";
  return formatUtcTime(new Date(ms)).slice(0, 5);
}

function fmtHms(ms: number | null): string {
  return ms === null ? "—" : formatUtcTime(new Date(ms));
}

function fmtKm(v: unknown): string {
  return isFiniteNumber(v) ? v.toFixed(2) : "—";
}

function fmtInt(v: unknown): string {
  return isFiniteNumber(v) ? Math.round(v).toLocaleString() : "—";
}

function fmtCompact(v: unknown): string {
  if (!isFiniteNumber(v)) return "—";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  return Math.round(v).toLocaleString();
}

function fmtLat(deg: number): string {
  return `${Math.abs(deg).toFixed(2)}° ${deg >= 0 ? "N" : "S"}`;
}

function fmtLon(deg: number): string {
  return `${Math.abs(deg).toFixed(2)}° ${deg >= 0 ? "E" : "W"}`;
}

/** "T+18m 07s" — closest approach relative to liftoff. */
function fmtTPlus(tcaMs: number | null, launchMs: number | null): string {
  if (tcaMs === null || launchMs === null) return "";
  const d = tcaMs - launchMs;
  return Number.isFinite(d) && d >= 0 ? `T+${formatDuration(d)}` : "";
}

function shortSiteLabel(label: string): string {
  const head = label.split(" · ")[0];
  return head || label;
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const e = (data as { error?: unknown }).error;
    if (typeof e === "string" && e.trim()) return e;
  }
  return `Launch COLA request failed (HTTP ${status}).`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/* ------------------------------------------------------------
   Response guard + sanitiser (never trust a JSON body blindly)
   ------------------------------------------------------------ */

const STATUSES: ReadonlySet<string> = new Set(["GO", "CAUTION", "NO-GO"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sanitizeMinute(v: unknown): ColaMinute | null {
  if (!isObject(v)) return null;
  if (parseIsoMs(v.launchTime) === null) return null;
  if (typeof v.status !== "string" || !STATUSES.has(v.status)) return null;
  return {
    launchTime: v.launchTime as string,
    status: v.status as ColaStatus,
    minMissKm: isFiniteNumber(v.minMissKm) ? v.minMissKm : null,
    objectName: typeof v.objectName === "string" && v.objectName ? v.objectName : null,
    noradId: typeof v.noradId === "string" && v.noradId ? v.noradId : null,
    tca: parseIsoMs(v.tca) !== null ? (v.tca as string) : null,
  };
}

function parseColaResult(v: unknown): ColaResult | null {
  if (!isObject(v)) return null;
  if (!Array.isArray(v.minutes) || !isObject(v.summary)) return null;
  if (!isObject(v.site) || typeof v.site.label !== "string" || typeof v.site.id !== "string") return null;
  if (!isObject(v.orbit) || typeof v.orbit.label !== "string" || typeof v.orbit.id !== "string") return null;
  if (parseIsoMs(v.windowStart) === null || parseIsoMs(v.windowEnd) === null) return null;
  const minutes: ColaMinute[] = [];
  for (const m of v.minutes) {
    const s = sanitizeMinute(m);
    if (s) minutes.push(s);
  }
  const summary = v.summary;
  const ncw = isObject(summary.nextClearWindow) ? summary.nextClearWindow : null;
  const nextClearWindow =
    ncw && parseIsoMs(ncw.start) !== null && isFiniteNumber(ncw.minutes)
      ? { start: ncw.start as string, minutes: ncw.minutes }
      : null;
  return {
    ...(v as unknown as ColaResult),
    stepMinutes: isFiniteNumber(v.stepMinutes) && v.stepMinutes > 0 ? v.stepMinutes : 1,
    minutes,
    summary: {
      go: isFiniteNumber(summary.go) ? summary.go : minutes.filter((m) => m.status === "GO").length,
      caution: isFiniteNumber(summary.caution)
        ? summary.caution
        : minutes.filter((m) => m.status === "CAUTION").length,
      noGo: isFiniteNumber(summary.noGo) ? summary.noGo : minutes.filter((m) => m.status === "NO-GO").length,
      nextClearWindow,
    },
    truncated: v.truncated === true,
  };
}

/** Assumptions read back from the result when present, else the lib constants. */
function assumptionsOf(result: ColaResult | null): ColaAssumptions {
  const a = result && isObject(result.assumptions) ? result.assumptions : null;
  const num = (x: unknown, fallback: number): number => (isFiniteNumber(x) ? x : fallback);
  return {
    insertionDelayS: num(a?.insertionDelayS, INSERTION_DELAY_S),
    downrangeDeg: num(a?.downrangeDeg, DOWNRANGE_DEG),
    screenAfterInsertionS: num(a?.screenAfterInsertionS, SCREEN_AFTER_INSERTION_S),
    screenStepS: num(a?.screenStepS, SCREEN_STEP_S),
    altBandKm: num(a?.altBandKm, ALT_BAND_KM),
    redKm: num(a?.redKm, COLA_RED_KM),
    yellowKm: num(a?.yellowKm, COLA_YELLOW_KM),
  };
}

function windowMinutesOf(result: ColaResult): number | null {
  const s = parseIsoMs(result.windowStart);
  const e = parseIsoMs(result.windowEnd);
  if (s === null || e === null || e <= s) return null;
  return Math.round((e - s) / 60_000);
}

/* ------------------------------------------------------------
   Small presentational pieces
   ------------------------------------------------------------ */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  testId,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`rounded border px-2 py-1 font-mono text-[0.65rem] tracking-wide transition-colors ${
        active
          ? "border-safe/60 bg-safe/15 text-safe"
          : "border-glass bg-white/5 text-text-secondary hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: ColaStatus }) {
  const color = STATUS_COLORS[status];
  return (
    <span
      className="inline-block shrink-0 rounded px-2 py-0.5 font-display text-[0.6rem] font-bold"
      style={{ color, border: `1px solid ${color}` }}
    >
      {status}
    </span>
  );
}

function CountCell({
  label,
  value,
  color,
  testId,
  na = false,
}: {
  label: string;
  value: number;
  color: string;
  testId: string;
  /** Nothing was screened: show n/a instead of a count that implies a verdict. */
  na?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-glass bg-white/5 p-3">
      <div className="truncate font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">{label}</div>
      <div
        className="mt-1 font-display text-2xl font-bold leading-tight"
        style={{ color: na ? "#888888" : color }}
        data-testid={testId}
      >
        {na ? "n/a" : fmtInt(value)}
      </div>
      <div className="font-mono text-[0.6rem] text-text-secondary">{na ? "nothing screened" : "liftoff min"}</div>
    </div>
  );
}

/* ------------------------------------------------------------
   Timeline (SVG bars + HTML ticks + HTML tooltip)
   ------------------------------------------------------------ */

interface Slot {
  launchMs: number;
  minute: ColaMinute | null; // null = not screened (compute budget)
}

function buildSlots(result: ColaResult): Slot[] {
  const startMs = parseIsoMs(result.windowStart) ?? 0;
  const stepMs = result.stepMinutes * 60_000;
  const wm = windowMinutesOf(result);
  const total = Math.max(
    1,
    wm !== null ? Math.floor(wm / result.stepMinutes) : result.minutes.length
  );
  const slots: Slot[] = [];
  for (let i = 0; i < total; i++) slots.push({ launchMs: startMs + i * stepMs, minute: null });
  for (const m of result.minutes) {
    const ms = parseIsoMs(m.launchTime);
    if (ms === null) continue;
    const idx = Math.round((ms - startMs) / stepMs);
    if (idx >= 0 && idx < total) slots[idx].minute = m;
  }
  return slots;
}

function Timeline({ result, noCandidates }: { result: ColaResult; noCandidates: boolean }) {
  const slots = useMemo(() => buildSlots(result), [result]);
  const [hover, setHover] = useState<number | null>(null);
  const [tipWidthPx, setTipWidthPx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // A fresh result invalidates any pinned tooltip.
  useEffect(() => {
    setHover(null);
  }, [result]);

  // Touch pointers never fire pointerleave, so a tapped tooltip needs an
  // outside tap to clear it. Listener only lives while a tooltip is open.
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

  // Measure the tooltip's real pixel width after every hover change,
  // before paint, so the clamp below keeps it inside the wrapper (the
  // panel is overflow-hidden — anything past the edge is clipped). Its
  // width (w-max, capped at the wrapper) does not depend on `left`, so
  // one measurement is exact. Client-only: the Timeline renders only
  // after a fetched result, never during SSR.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width; // fractional; only translateY is applied
    setTipWidthPx((prev) => (prev === width ? prev : width));
  }, [hover, slots, noCandidates]);

  const n = slots.length;
  const w = VB_W / n;
  const gap = Math.min(1, w * 0.25);

  const indexFromPointer = (e: React.PointerEvent<SVGSVGElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    const frac = (e.clientX - rect.left) / rect.width;
    if (!Number.isFinite(frac)) return null;
    return Math.max(0, Math.min(n - 1, Math.floor(frac * n)));
  };

  const startMs = parseIsoMs(result.windowStart) ?? 0;
  const wm = windowMinutesOf(result) ?? n * result.stepMinutes;
  const ticks: { minutes: number; ms: number }[] = [];
  for (let t = 0; t <= wm; t += TICK_EVERY_MINUTES) ticks.push({ minutes: t, ms: startMs + t * 60_000 });

  const hovered = hover !== null && hover >= 0 && hover < n ? slots[hover] : null;
  let tooltipStyle: React.CSSProperties | null = null;
  if (hovered && hover !== null) {
    // Centred on the bar, clamped to [0, wrapper width − tooltip width].
    // Percentages resolve against the wrapper, so the clamp also holds
    // when the wrapper resizes (rotation) with a tooltip pinned.
    const centerPct = ((hover + 0.5) / n) * 100;
    const half = tipWidthPx / 2;
    tooltipStyle = {
      left: `clamp(0px, calc(${centerPct}% - ${half}px), calc(100% - ${tipWidthPx}px))`,
      top: 0,
      transform: "translateY(calc(-100% - 6px))",
    };
  }

  const counts = result.summary;
  const ariaLabel = noCandidates
    ? "Launch window timeline: no catalog objects in the altitude band — nothing screened"
    : `Launch window timeline: ${counts.go} GO, ${counts.caution} CAUTION, ${counts.noGo} NO-GO liftoff minutes`;

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
          data-testid="cola-timeline"
          className="block h-14 w-full cursor-crosshair touch-pan-y"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={ariaLabel}
          onPointerMove={(e) => setHover(indexFromPointer(e))}
          onPointerDown={(e) => setHover(indexFromPointer(e))}
        >
          <title>{ariaLabel}</title>
          {/* Baseline */}
          <line x1={0} x2={VB_W} y1={BAR_Y + BAR_H} y2={BAR_Y + BAR_H} stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
          {slots.map((s, i) => {
            const st = noCandidates ? undefined : s.minute?.status;
            return (
              <rect
                key={i}
                x={i * w + gap / 2}
                y={BAR_Y}
                width={Math.max(0.1, w - gap)}
                height={BAR_H}
                fill={st ? STATUS_COLORS[st] : UNSCREENED_FILL}
                fillOpacity={st ? STATUS_OPACITY[st] : 1}
              />
            );
          })}
          {hover !== null && hover >= 0 && hover < n && (
            <rect
              x={hover * w}
              y={BAR_Y - 1.5}
              width={w}
              height={BAR_H + 3}
              fill="none"
              stroke="#E0E0E0"
              strokeWidth={0.8}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
          {ticks.map((t) => {
            const x = Math.min(VB_W - 0.25, Math.max(0.25, (t.minutes / wm) * VB_W));
            return (
              <line
                key={t.minutes}
                x1={x}
                x2={x}
                y1={TICK_Y0}
                y2={TICK_Y1}
                stroke="#888888"
                strokeWidth={0.6}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {hovered && tooltipStyle && (
          <div
            ref={tipRef}
            data-testid="cola-tooltip"
            className="pointer-events-none absolute z-10 w-max max-w-full break-words rounded border border-glass bg-space/95 px-2 py-1.5 font-mono text-[0.6rem] leading-snug shadow-lg"
            style={tooltipStyle}
          >
            <TooltipBody slot={hovered} noCandidates={noCandidates} />
          </div>
        )}
      </div>

      {/* HTML tick labels (stay legible at any width) */}
      <div className="relative mt-0.5 h-4 font-mono text-[0.6rem] text-text-secondary" aria-hidden="true">
        {ticks.map((t, i) => {
          const frac = wm > 0 ? t.minutes / wm : 0;
          const tx = i === 0 ? "0%" : frac >= 0.999 ? "-100%" : "-50%";
          return (
            <span
              key={t.minutes}
              className="absolute top-0 whitespace-nowrap"
              style={{ left: `${frac * 100}%`, transform: `translateX(${tx})` }}
            >
              {fmtHm(t.ms)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TooltipBody({ slot, noCandidates }: { slot: Slot; noCandidates: boolean }) {
  const m = slot.minute;
  if (noCandidates) {
    return (
      <>
        <div className="text-text-secondary">liftoff {fmtHm(slot.launchMs)} UTC</div>
        <div className="text-text-primary">no catalog objects in the altitude band — nothing screened</div>
      </>
    );
  }
  if (!m) {
    return (
      <>
        <div className="text-text-secondary">liftoff {fmtHm(slot.launchMs)} UTC</div>
        <div className="text-text-primary">not screened — compute budget reached</div>
      </>
    );
  }
  const tcaMs = parseIsoMs(m.tca);
  const tPlus = fmtTPlus(tcaMs, slot.launchMs);
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-text-secondary">liftoff {fmtHm(slot.launchMs)} UTC</span>
        <span className="font-display font-bold" style={{ color: STATUS_COLORS[m.status] }}>
          {m.status}
        </span>
      </div>
      <div className="text-xs font-bold text-text-primary">
        {fmtKm(m.minMissKm)} <span className="font-normal text-text-secondary">km min miss</span>
      </div>
      {m.objectName && (
        <div className="text-text-secondary">
          <span className="text-text-primary">{m.objectName}</span>
          {m.noradId ? ` (NORAD ${m.noradId})` : ""}
        </div>
      )}
      {tcaMs !== null && (
        <div className="text-text-secondary">
          closest {fmtHms(tcaMs)} UTC{tPlus ? ` · ${tPlus}` : ""}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------
   Blackout table
   ------------------------------------------------------------ */

function BlackoutRow({ minute }: { minute: ColaMinute }) {
  const launchMs = parseIsoMs(minute.launchTime);
  const tcaMs = parseIsoMs(minute.tca);
  const tPlus = fmtTPlus(tcaMs, launchMs);
  const cell = "border-b border-glass px-2 py-1.5 align-top";
  return (
    <tr data-testid="cola-blackout-row" className="text-text-primary">
      <td className={`${cell} whitespace-nowrap`}>{launchMs !== null ? formatUtc(new Date(launchMs)).slice(0, 16) : "—"}</td>
      <td className={cell}>
        <StatusBadge status={minute.status} />
      </td>
      <td className={`${cell} text-right tabular-nums`} style={{ color: STATUS_COLORS[minute.status] }}>
        {fmtKm(minute.minMissKm)}
      </td>
      <td className={cell}>
        {minute.objectName ?? "—"}
        {minute.noradId && <span className="text-text-secondary"> ({minute.noradId})</span>}
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        {fmtHms(tcaMs)}
        {tPlus && <span className="text-text-secondary"> · {tPlus}</span>}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------
   Panel
   ------------------------------------------------------------ */

interface RunRequest {
  siteId: string;
  orbitId: string;
  minutes: number;
  nonce: number;
}

export default function LaunchCola() {
  const [siteId, setSiteId] = useState(DEFAULT_SITE_ID);
  const [orbitId, setOrbitId] = useState(DEFAULT_ORBIT_ID);
  const [windowMinutes, setWindowMinutes] = useState(DEFAULT_WINDOW_MINUTES);

  const [run, setRun] = useState<RunRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ColaResult | null>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const autoRunDone = useRef(false);
  const selectionRef = useRef({ siteId, orbitId, windowMinutes });

  useEffect(() => {
    selectionRef.current = { siteId, orbitId, windowMinutes };
  }, [siteId, orbitId, windowMinutes]);

  const site = findLaunchSite(siteId) ?? LAUNCH_SITES[0];
  const orbit = findTargetOrbit(orbitId) ?? TARGET_ORBITS[0];
  const reachable = useMemo(() => orbitReachable(site, orbit), [site, orbit]);
  const direction = ascentDirection(site, orbit);

  /** Queue a screen of the given selection (the effect below fetches). */
  const requestRun = useCallback((sel: { siteId: string; orbitId: string; windowMinutes: number }) => {
    const s = findLaunchSite(sel.siteId);
    const o = findTargetOrbit(sel.orbitId);
    if (!s || !o || !orbitReachable(s, o)) return;
    setRun((prev) => ({
      siteId: sel.siteId,
      orbitId: sel.orbitId,
      minutes: sel.windowMinutes,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, []);

  /* ---- One automatic screen the first time the panel scrolls into view ---- */
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || autoRunDone.current) return;
    const start = (): void => {
      if (autoRunDone.current) return;
      autoRunDone.current = true;
      requestRun(selectionRef.current);
    };
    if (typeof IntersectionObserver === "undefined") {
      start();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { rootMargin: "200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [requestRun]);

  /* ---- Screening run ---- */
  useEffect(() => {
    if (!run) return;
    autoRunDone.current = true; // a manual run also satisfies the auto-run
    let cancelled = false;
    const controller = new AbortController();
    setRunning(true);
    setError(null);

    (async () => {
      try {
        const url = `/api/cola?site=${encodeURIComponent(run.siteId)}&orbit=${encodeURIComponent(
          run.orbitId
        )}&minutes=${run.minutes}`;
        const res = await timedFetch(url, { signal: controller.signal });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (cancelled) return;
        if (!res.ok) throw new Error(errorMessage(data, res.status));
        const parsed = parseColaResult(data);
        if (!parsed) throw new Error("Launch COLA response was malformed.");
        setResult(parsed);
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : "Launch COLA screen failed.");
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [run]);

  function handleRun() {
    if (running || !reachable) return;
    requestRun({ siteId, orbitId, windowMinutes });
  }

  const a = assumptionsOf(result);
  const blackouts = useMemo(
    () => (result ? result.minutes.filter((m) => m.status !== "GO") : []),
    [result]
  );
  const drivers = useMemo(() => {
    const byId = new Map<string, { name: string; noradId: string; count: number }>();
    for (const m of blackouts) {
      const key = m.noradId ?? m.objectName ?? "";
      if (!key) continue;
      const entry = byId.get(key);
      if (entry) entry.count++;
      else byId.set(key, { name: m.objectName ?? `NORAD ${key}`, noradId: m.noradId ?? "", count: 1 });
    }
    return Array.from(byId.values())
      .sort((x, y) => y.count - x.count)
      .slice(0, DRIVER_COUNT);
  }, [blackouts]);

  const resultWindow = result ? windowMinutesOf(result) : null;
  const totalSlots = result && resultWindow !== null ? Math.floor(resultWindow / result.stepMinutes) : 0;
  const selectionChanged =
    !!result &&
    (result.site.id !== siteId || result.orbit.id !== orbitId || resultWindow !== windowMinutes);

  // Nothing passed the altitude prefilter: every minute is "GO" only
  // because nothing was screened — never present that as a clear window.
  const noCandidates = !!result && result.candidatesScreened === 0;

  const ncw = result?.summary.nextClearWindow ?? null;
  const ncwStartMs = ncw ? parseIsoMs(ncw.start) : null;
  const windowEndMs = result ? parseIsoMs(result.windowEnd) : null;
  const ncwRunsToEnd =
    ncw !== null &&
    ncwStartMs !== null &&
    windowEndMs !== null &&
    ncwStartMs + ncw.minutes * 60_000 >= windowEndMs;

  return (
    <section ref={sectionRef} className="glass-card overflow-hidden" data-testid="launch-cola">
      <div className="flex h-9 items-center justify-between border-b border-glass px-3">
        <h2 className="shrink-0 font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          LAUNCH COLA SCREENING
        </h2>
        <span className="min-w-0 truncate pl-3 font-mono text-[0.65rem] text-text-muted">
          simplified ascent model · catalog sample
        </span>
      </div>

      <div className="p-4">
        {/* ---- Controls ---- */}
        <div className="flex flex-col gap-3">
          <div>
            <Label>Launch site</Label>
            <div className="flex flex-wrap gap-1.5">
              {LAUNCH_SITES.map((s) => (
                <ToggleButton
                  key={s.id}
                  testId={`cola-site-${s.id}`}
                  active={s.id === siteId}
                  title={s.label}
                  onClick={() => setSiteId(s.id)}
                >
                  {shortSiteLabel(s.label)}
                </ToggleButton>
              ))}
            </div>
          </div>

          <div>
            <Label>Target orbit</Label>
            <div className="flex flex-wrap gap-1.5">
              {TARGET_ORBITS.map((o) => (
                <ToggleButton
                  key={o.id}
                  testId={`cola-orbit-${o.id}`}
                  active={o.id === orbitId}
                  onClick={() => setOrbitId(o.id)}
                >
                  {o.label}
                </ToggleButton>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Launch window</Label>
              <div className="flex flex-wrap gap-1.5">
                {COLA_WINDOW_OPTIONS.map((m) => (
                  <ToggleButton
                    key={m}
                    testId={`cola-window-${m}`}
                    active={m === windowMinutes}
                    onClick={() => setWindowMinutes(m)}
                  >
                    {m} min
                  </ToggleButton>
                ))}
              </div>
            </div>
            <button
              type="button"
              data-testid="cola-run"
              onClick={handleRun}
              disabled={running || !reachable}
              className="rounded border border-safe/60 bg-safe/15 px-3 py-1 font-mono text-[0.65rem] tracking-wide text-safe transition-colors hover:bg-safe/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "SCREENING…" : "RUN SCREEN"}
            </button>
          </div>

          <div className="font-mono text-[0.65rem] text-text-secondary">
            {site.label} · {fmtLat(site.latitudeDeg)} {fmtLon(site.longitudeDeg)} → {orbit.label} ·
            ascent <span className="text-text-primary">{direction}</span> · liftoff every minute, insertion T+
            {Math.round(INSERTION_DELAY_S / 60)} min
          </div>

          {!reachable && (
            <div
              data-testid="cola-unreachable"
              className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 font-mono text-xs text-caution"
            >
              {orbit.label} cannot be screened from {shortSiteLabel(site.label)}: its inclination (
              {orbit.inclinationDeg}°) is below the site latitude ({site.latitudeDeg.toFixed(2)}°), so no
              direct-ascent orbit plane passes through the pad. Reaching it would need a dogleg / plane change,
              which this model does not simulate.
            </div>
          )}
        </div>

        {/* ---- States ---- */}
        {running && !result && (
          <div className="mt-4 font-mono text-xs text-text-secondary blink-cursor">
            Screening every liftoff minute against the catalog sample
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {error}
          </div>
        )}

        {!result && !running && !error && (
          <div className="mt-4 font-mono text-xs text-text-muted">
            Pick a site, target orbit and window, then RUN SCREEN.
          </div>
        )}

        {/* ---- Result ---- */}
        {result && (
          <div
            data-testid="cola-result"
            className={`mt-4 flex flex-col gap-4 transition-opacity ${running ? "opacity-60" : ""}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono text-[0.65rem] text-text-secondary">
              <span>
                <span className="text-text-primary">{result.site.label}</span> → {result.orbit.label} · window{" "}
                {fmtHm(parseIsoMs(result.windowStart))}–{fmtHm(windowEndMs)} UTC{" "}
                {parseIsoMs(result.windowStart) !== null
                  ? formatUtc(new Date(parseIsoMs(result.windowStart) as number)).slice(0, 10)
                  : ""}
              </span>
              {running ? (
                <span className="blink-cursor">re-screening</span>
              ) : selectionChanged ? (
                <span className="text-text-muted">selection changed — press RUN SCREEN to update</span>
              ) : null}
            </div>

            {/* Summary */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3 md:grid-cols-4">
              <CountCell
                label="GO"
                value={result.summary.go}
                color={STATUS_COLORS.GO}
                testId="cola-count-go"
                na={noCandidates}
              />
              <CountCell
                label="CAUTION"
                value={result.summary.caution}
                color={STATUS_COLORS.CAUTION}
                testId="cola-count-caution"
                na={noCandidates}
              />
              <CountCell
                label="NO-GO"
                value={result.summary.noGo}
                color={STATUS_COLORS["NO-GO"]}
                testId="cola-count-nogo"
                na={noCandidates}
              />
              <div className="col-span-3 rounded-md border border-glass bg-white/5 p-3 md:col-span-1">
                <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                  Next clear window
                </div>
                <div className="mt-1 font-mono text-xs text-text-primary sm:text-sm" data-testid="cola-next-clear">
                  {noCandidates ? (
                    <span className="text-text-secondary">n/a</span>
                  ) : ncw && ncwStartMs !== null ? (
                    <>
                      opens <span className="text-safe">{fmtHm(ncwStartMs)} UTC</span> · {fmtInt(ncw.minutes)} min
                    </>
                  ) : (
                    "none in window"
                  )}
                </div>
                {noCandidates ? (
                  <div className="font-mono text-[0.6rem] text-text-secondary">nothing screened</div>
                ) : (
                  ncwRunsToEnd && (
                    <div className="font-mono text-[0.6rem] text-text-secondary">runs to the end of the window</div>
                  )
                )}
              </div>
            </div>

            {/* Timeline */}
            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <Label>Liftoff timeline (UTC) — one bar per launch minute</Label>
                <div className="flex flex-wrap items-center gap-3 font-mono text-[0.6rem] text-text-secondary">
                  {(["GO", "CAUTION", "NO-GO"] as const).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1">
                      <span
                        className="inline-block h-2 w-2 rounded-sm"
                        style={{ backgroundColor: STATUS_COLORS[s], opacity: STATUS_OPACITY[s] }}
                      />
                      {s}
                      {s === "NO-GO" ? ` < ${a.redKm} km` : s === "CAUTION" ? ` < ${a.yellowKm} km` : ""}
                    </span>
                  ))}
                </div>
              </div>
              <Timeline result={result} noCandidates={noCandidates} />
            </div>

            {result.truncated && (
              <div className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 font-mono text-xs text-caution">
                Compute budget reached — {fmtInt(result.minutes.length)} of {fmtInt(totalSlots)} launch minutes
                screened (grey bars were not screened). Re-run with a shorter window for full coverage.
              </div>
            )}

            {/* Blackouts */}
            <div>
              <Label>Blackout minutes (CAUTION / NO-GO)</Label>
              {noCandidates ? (
                <div
                  data-testid="cola-no-candidates"
                  className="rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-xs text-text-secondary"
                >
                  {result.sampleSize === 0
                    ? "The catalog sample is empty — nothing to screen against."
                    : `No catalog objects in the ±${a.altBandKm} km band around ${fmtInt(
                        result.orbit.altitudeKm
                      )} km — nothing to screen against (sample size ${fmtInt(result.sampleSize)}).`}{" "}
                  This is not a GO verdict.
                </div>
              ) : blackouts.length > 0 ? (
                <>
                  {drivers.length > 0 && (
                    <div className="mb-2 font-mono text-[0.65rem] text-text-secondary">
                      Driven by{" "}
                      {drivers.map((d, i) => (
                        <span key={`${d.noradId}-${d.name}`}>
                          {i > 0 ? " · " : ""}
                          <span className="text-text-primary">{d.name}</span>
                          {d.noradId ? ` (${d.noradId})` : ""} × {d.count} min
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="max-h-80 overflow-auto rounded-md border border-glass">
                    <table className="w-full border-separate border-spacing-0 whitespace-nowrap text-left font-mono text-[0.65rem]">
                      <thead className="sticky top-0 bg-space">
                        <tr className="text-[0.6rem] tracking-widest text-text-muted">
                          <th className="border-b border-glass px-2 py-1.5 font-normal">LAUNCH T0 (UTC)</th>
                          <th className="border-b border-glass px-2 py-1.5 font-normal">STATUS</th>
                          <th className="border-b border-glass px-2 py-1.5 text-right font-normal">MIN MISS km</th>
                          <th className="border-b border-glass px-2 py-1.5 font-normal">OBJECT (NORAD)</th>
                          <th className="border-b border-glass px-2 py-1.5 font-normal">CLOSEST AT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {blackouts.map((m) => (
                          <BlackoutRow key={m.launchTime} minute={m} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-safe/40 bg-safe/10 px-3 py-2 font-mono text-xs text-text-primary">
                  <StatusBadge status="GO" />
                  <span>
                    {result.truncated
                      ? `No blackout minutes among the ${fmtInt(result.minutes.length)} screened — the rest of the window was not screened.`
                      : `No blackout minutes — every screened liftoff clears ${a.yellowKm} km over the ${Math.round(
                          a.screenAfterInsertionS / 60
                        )}-min coast.`}
                  </span>
                </div>
              )}
            </div>

            {/* Stats */}
            <div className="font-mono text-[0.65rem] text-text-secondary" data-testid="cola-stats">
              <span className="text-text-primary">{fmtInt(result.candidatesScreened)}</span> candidates screened /{" "}
              {fmtInt(result.sampleSize)} sample objects (±{a.altBandKm} km altitude prefilter) ·{" "}
              <span className="text-text-primary">{fmtCompact(result.propagations)}</span> propagations ·{" "}
              <span className="text-text-primary">{fmtInt(result.computeMs)}</span> ms compute
              {result.truncated && <span className="text-caution"> · truncated by compute budget</span>}
            </div>
          </div>
        )}

        {/* Footnote — always visible */}
        <div
          data-testid="cola-footnote"
          className="mt-4 border-t pt-2 font-mono text-[0.6rem] leading-relaxed text-text-muted"
          style={{ borderColor: GLASS_BORDER }}
        >
          Simplified model: instantaneous insertion at T+{Math.round(a.insertionDelayS / 60)} min,{" "}
          {a.downrangeDeg}° downrange, two-body coast for {Math.round(a.screenAfterInsertionS / 60)} min,
          screened against the 2,000-object sample at {a.screenStepS} s steps. Real COLA uses the full ascent
          trajectory, covariance, and the complete catalog — this is an engineering demonstration, not a
          launch-commit product. Within each step the closest approach is refined with straight-line relative
          motion. The vehicle is inserted directly into the circular target orbit (real deployments, e.g.
          Starlink, insert lower and raise); the orbit plane passes through the pad at liftoff, Vandenberg and
          retrograde (SSO) ascents fly south, others north. Miss distance only — no covariance or Pc: NO-GO &lt;{" "}
          {a.redKm} km, CAUTION &lt; {a.yellowKm} km. Catalog objects use SGP4 on public TLEs (~1 km error at
          epoch, growing with age).
        </div>
      </div>
    </section>
  );
}
