"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  ScreeningAssessment,
  ScreeningAssessmentRequest,
  ScreeningCloseApproach,
  ScreeningDisposition,
  ScreeningResult,
  ThreatLevel,
} from "@/lib/prompts";
import { formatDuration, formatUtc } from "@/lib/orbital";
import {
  DEFAULT_SCREENING_OPTIONS,
  SCREENING_WINDOW_OPTIONS,
} from "@/lib/screening";

/* ============================================================
   Session 5 — Feature 2: SGP4 Conjunction Screening Engine

   Deterministic all-on-one screening of ONE target against the
   2,000-object Space-Track sample, plus an optional AI conjunction
   assessment memo on top of the numbers.

   Data flow
   - RUN SCREEN  → GET /api/screen?target=<name|NORAD>&hours=<h>
                   (server: 5-min cache per target|hours; SGP4
                   coarse 60 s grid + golden-section refinement;
                   Pc under the stated TLE-grade covariance).
   - ▸ AI conjunction assessment
                 → POST /api/assess with the ScreeningResult subset
                   (top 8 approaches by miss). Claude interprets the
                   screening numbers and returns a CARA-style memo
                   with a GREEN / YELLOW / RED disposition. The memo
                   is cleared whenever a new screen runs.

   Refresh cadence: none — screening is on demand (each run is up
   to ~20 s of server CPU). A 1 s ticker drives the "Δ from now"
   column only; it is started inside an effect so the initial
   render never reads the clock.

   Assumptions shown on screen (never hardcoded in the UI — they
   are read back from result.assumptions):
   - per-object 1-σ RIC covariance, combined hard-body radius,
     NASA ISS keep-out box half-widths, coarse step, window.
   - Pc is the short-encounter 2-D estimate; rows with relative
     speed < 0.1 km/s (co-orbital) carry a † because that
     approximation is indicative only there.
   - The reporting threshold comes from result.assumptions
     (reportThresholdKm), i.e. exactly what the route used; the
     DEFAULT_SCREENING_OPTIONS value is only the pre-run fallback.

   Terminology: TCA = time of closest approach; Pc = probability of
   collision; RIC = radial / in-track / cross-track (target frame);
   CDM = conjunction data message; 18 SDS = 18th Space Defense
   Squadron. This panel is a screening aid, NOT an operational CDM.
   ============================================================ */

const DEFAULT_TARGET = "ISS";
const DEFAULT_HOURS = 24;
const ASSESS_TOP_N = 8;
/** Below this relative speed the 2-D short-encounter Pc is indicative only. */
const CO_ORBITAL_VREL_KM_S = 0.1;
const GLASS_BORDER = "rgba(255,255,255,0.08)";

const SEVERITY_COLORS: Record<ThreatLevel, string> = {
  LOW: "#00FF41",
  MEDIUM: "#FFB800",
  HIGH: "#FF8A2B",
  CRITICAL: "#FF3131",
};

const DISPOSITION_COLORS: Record<ScreeningDisposition, string> = {
  GREEN: "#00FF41",
  YELLOW: "#FFB800",
  RED: "#FF3131",
};

/* ------------------------------------------------------------
   Formatting helpers — every value is guarded so the table never
   shows NaN / undefined / "Invalid Date".
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
  return v < 0 ? `-${abs}` : `+${abs}`;
}

function fmtExp(v: unknown): string {
  return isFiniteNumber(v) ? v.toExponential(2) : "—";
}

function fmtInt(v: unknown): string {
  return isFiniteNumber(v) ? Math.round(v).toLocaleString() : "—";
}

function parseIso(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fmtUtcIso(v: unknown): string {
  const d = parseIso(v);
  return d ? formatUtc(d) : "—";
}

/** "epoch 3.2 h old" relative to the screening start. */
function epochAgeLabel(epochIso: unknown, refIso: unknown): string {
  const epoch = parseIso(epochIso);
  const ref = parseIso(refIso);
  if (!epoch || !ref) return "epoch —";
  const hours = (ref.getTime() - epoch.getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return "epoch —";
  if (Math.abs(hours) >= 72) return `epoch ${(hours / 24).toFixed(1)} d old`;
  return `epoch ${hours.toFixed(1)} h old`;
}

/** "in 2h 14m" / "5m 10s ago" relative to the live clock. */
function deltaLabel(tcaIso: unknown, nowMs: number | null): string | null {
  const tca = parseIso(tcaIso);
  if (!tca || nowMs === null) return null;
  const delta = tca.getTime() - nowMs;
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return hex;
  return `rgba(${r},${g},${b},${alpha})`;
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

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-glass bg-white/5 px-3 py-2">
      <Label>{label}</Label>
      <div className="font-mono text-xs text-text-primary">{value}</div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: ThreatLevel }) {
  const color = SEVERITY_COLORS[severity] ?? "#FFB800";
  const isCritical = severity === "CRITICAL";
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 font-display text-[0.6rem] font-bold ${
        isCritical ? "animate-pulse-alert" : ""
      }`}
      style={{ color, border: `1px solid ${color}` }}
    >
      {severity}
    </span>
  );
}

function ApproachRow({
  index,
  event,
  nowMs,
}: {
  index: number;
  event: ScreeningCloseApproach;
  nowMs: number | null;
}) {
  const isCritical = event.severity === "CRITICAL";
  const coOrbital =
    isFiniteNumber(event.relativeVelocityKmS) &&
    event.relativeVelocityKmS < CO_ORBITAL_VREL_KM_S;
  const delta = deltaLabel(event.tca, nowMs);
  const cell = "border-b border-glass px-2 py-1.5 align-top whitespace-nowrap";
  const num = `${cell} text-right`;

  return (
    <tr
      className={isCritical ? "animate-pulse-alert" : ""}
      style={{
        backgroundColor: isCritical ? "rgba(255,49,49,0.08)" : undefined,
      }}
    >
      <td className={`${cell} text-text-muted`}>{index + 1}</td>
      <td className={cell}>
        <div className="text-text-primary">{event.name || "—"}</div>
        <div className="text-[0.6rem] text-text-muted">
          NORAD {event.noradId || "—"} · {event.objectClass || "UNKNOWN"}
        </div>
      </td>
      <td className={cell}>
        <div className="text-text-primary">{fmtUtcIso(event.tca)}</div>
        {delta && <div className="text-[0.6rem] text-text-muted">{delta}</div>}
      </td>
      <td className={`${num} text-text-primary`}>{fmtFixed(event.missDistanceKm, 3)}</td>
      <td className={`${num} text-text-secondary`}>{fmtFixed(event.relativeVelocityKmS, 2)}</td>
      <td className={`${num} text-text-secondary`}>{fmtSigned(event.radialKm, 2)}</td>
      <td className={`${num} text-text-secondary`}>{fmtSigned(event.inTrackKm, 2)}</td>
      <td className={`${num} text-text-secondary`}>{fmtSigned(event.crossTrackKm, 2)}</td>
      <td className={`${num} text-text-primary`}>
        {fmtExp(event.probabilityOfCollision)}
        {coOrbital && (
          <span
            className="ml-0.5 text-text-muted"
            title="Co-orbital encounter: short-encounter Pc approximation is indicative only"
          >
            †
          </span>
        )}
      </td>
      <td className={`${cell} text-center`}>
        {event.insideKeepOutBox ? (
          <span className="font-bold text-danger" title="Inside the NASA ISS keep-out box">
            ✓
          </span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>
      <td className={cell}>
        <SeverityBadge severity={event.severity} />
      </td>
    </tr>
  );
}

/** Memo panel — strips the trailing DISPOSITION line (rendered as a badge). */
function MemoPanel({ memo }: { memo: ScreeningAssessment }) {
  const color = DISPOSITION_COLORS[memo.disposition] ?? "#FFB800";
  const body = memo.text.replace(/DISPOSITION\s*:.*$/im, "").trim();
  return (
    <div
      data-testid="screen-memo"
      className="mt-3 rounded-md border p-3"
      style={{
        borderColor: hexToRgba(color, 0.6),
        backgroundColor: hexToRgba(color, 0.06),
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className="font-display text-[0.7rem] font-bold uppercase tracking-widest"
          style={{ color }}
        >
          ▸ Conjunction assessment memo
        </span>
        <span
          className="shrink-0 rounded px-2 py-0.5 font-display text-[0.65rem] font-bold"
          style={{ color, border: `1px solid ${color}` }}
        >
          DISPOSITION {memo.disposition}
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[0.65rem] leading-relaxed text-text-secondary">
        {body}
      </pre>
      <div className="mt-2 font-mono text-[0.6rem] text-text-muted">
        generated {fmtUtcIso(memo.generatedAt)} UTC · target NORAD {memo.targetNoradId}
      </div>
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

export default function ConjunctionScreener() {
  const [targetInput, setTargetInput] = useState(DEFAULT_TARGET);
  const [hours, setHours] = useState<number>(DEFAULT_HOURS);

  const [run, setRun] = useState<RunRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<ScreeningResult | null>(null);

  // 0 = no assessment requested for the current result.
  const [assessNonce, setAssessNonce] = useState(0);
  const [assessLoading, setAssessLoading] = useState(false);
  const [assessError, setAssessError] = useState<string | null>(null);
  const [memo, setMemo] = useState<ScreeningAssessment | null>(null);

  // Live clock for the "Δ from now" column — initialised in an effect.
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* ---- Screening run ---- */
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    const controller = new AbortController();

    setRunning(true);
    setRunError(null);
    setResult(null);
    // A new screen invalidates any memo written for the previous one.
    setMemo(null);
    setAssessError(null);
    setAssessNonce(0);

    (async () => {
      try {
        const url = `/api/screen?target=${encodeURIComponent(run.target)}&hours=${run.hours}`;
        const res = await fetch(url, { signal: controller.signal });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(errorMessage(data, res.status, "Screening request failed"));
        }
        if (!data || typeof data !== "object" || !Array.isArray((data as ScreeningResult).closeApproaches)) {
          throw new Error("Screening response was malformed.");
        }
        setResult(data as ScreeningResult);
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
  }, [run]);

  /* ---- AI assessment ---- */
  useEffect(() => {
    if (assessNonce === 0 || !result) return;
    let cancelled = false;
    const controller = new AbortController();

    setAssessLoading(true);
    setAssessError(null);
    setMemo(null);

    const topEvents = [...result.closeApproaches]
      .sort((a, b) => a.missDistanceKm - b.missDistanceKm)
      .slice(0, ASSESS_TOP_N);
    const body: ScreeningAssessmentRequest = {
      target: result.target,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      candidatesScreened: result.candidatesScreened,
      assumptions: result.assumptions,
      closeApproaches: topEvents,
    };

    (async () => {
      try {
        const res = await fetch("/api/assess", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(errorMessage(data, res.status, "Assessment request failed"));
        }
        if (!data || typeof data !== "object" || typeof (data as ScreeningAssessment).text !== "string") {
          throw new Error("Assessment response was malformed.");
        }
        setMemo(data as ScreeningAssessment);
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        setAssessError(err instanceof Error ? err.message : "Assessment failed.");
      } finally {
        if (!cancelled) setAssessLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      // Teardown means no assessment is in flight any more (a new screen
      // run reset `result` / `assessNonce` while the POST was pending).
      // The in-flight promise's `finally` skips this when cancelled, so
      // without it the button would stay disabled on "Writing assessment
      // memo…" for every later result until a page reload.
      setAssessLoading(false);
    };
  }, [assessNonce, result]);

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

  function handleAssess() {
    if (!result || assessLoading) return;
    setAssessNonce((n) => n + 1);
  }

  const a = result?.assumptions;
  const assumptionsLine = a
    ? `σ RIC ${fmtFixed(a.sigmaRicKm?.[0], 1)} / ${fmtFixed(a.sigmaRicKm?.[1], 1)} / ${fmtFixed(
        a.sigmaRicKm?.[2],
        1
      )} km per object · HBR ${fmtFixed(a.hardBodyRadiusM, 0)} m · keep-out box ±${fmtFixed(
        a.keepOutBoxKm?.radial,
        0
      )} × ±${fmtFixed(a.keepOutBoxKm?.inTrack, 0)} × ±${fmtFixed(a.keepOutBoxKm?.crossTrack, 0)} km`
    : null;

  const resultHours = isFiniteNumber(a?.windowHours) ? a.windowHours : run?.hours ?? hours;
  const hasCoOrbital =
    result?.closeApproaches.some(
      (e) => isFiniteNumber(e.relativeVelocityKmS) && e.relativeVelocityKmS < CO_ORBITAL_VREL_KM_S
    ) ?? false;

  return (
    <section className="glass-card overflow-hidden">
      {/* Header */}
      <div className="flex h-9 items-center justify-between border-b border-glass px-3">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          SGP4 CONJUNCTION SCREENING ENGINE
        </h2>
        <span className="hidden font-mono text-[0.65rem] text-text-muted sm:inline">
          deterministic · public TLE · Pc under stated covariance
        </span>
      </div>

      <div className="p-4">
        {/* ---- Controls ---- */}
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            data-testid="screen-target"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            placeholder="Satellite name or NORAD ID"
            maxLength={64}
            spellCheck={false}
            className="min-w-[12rem] flex-1 rounded-md border border-glass bg-white/5 px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-safe focus:outline-none"
          />
          <div className="flex items-center gap-1">
            {SCREENING_WINDOW_OPTIONS.map((h) => {
              const active = h === hours;
              return (
                <button
                  key={h}
                  type="button"
                  data-testid={`screen-hours-${h}`}
                  aria-pressed={active}
                  onClick={() => setHours(h)}
                  disabled={running}
                  className={`rounded border px-2 py-1 font-mono text-[0.65rem] tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    active
                      ? "border-safe/60 bg-safe/15 text-safe"
                      : "border-glass bg-white/5 text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {h}h
                </button>
              );
            })}
          </div>
          <button
            type="submit"
            data-testid="screen-run"
            disabled={running}
            className="rounded border border-safe/60 bg-safe/15 px-3 py-1 font-mono text-[0.65rem] font-semibold tracking-wide text-safe transition-colors hover:bg-safe/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? "Running SGP4 screen…" : "RUN SCREEN"}
          </button>
        </form>

        {/* ---- States ---- */}
        {running && run && (
          <div className="mt-3 font-mono text-xs text-text-secondary blink-cursor">
            Propagating candidates against {run.target} over {run.hours} h
          </div>
        )}

        {runError && (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {runError}
          </div>
        )}

        {!running && !runError && !result && (
          <div className="mt-3 font-mono text-xs text-text-muted">
            Enter a satellite name or NORAD ID, pick a window, and run the screen. The
            target is propagated with SGP4 against the 2,000-object Space-Track sample.
          </div>
        )}

        {/* ---- Results ---- */}
        {result && (
          <div data-testid="screen-results" className="mt-4 flex flex-col gap-4">
            {/* Target strip */}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-xs">
              <span className="font-display text-sm font-bold text-text-primary">
                {result.target?.name || "—"}
              </span>
              <span className="text-text-secondary">
                NORAD <span className="text-text-primary">{result.target?.noradId || "—"}</span>
              </span>
              <span className="text-text-secondary">
                mean alt{" "}
                <span className="text-text-primary">{fmtFixed(result.target?.meanAltitudeKm, 0)}</span> km
              </span>
              <span className="text-text-secondary">
                incl <span className="text-text-primary">{fmtFixed(result.target?.inclinationDeg, 2)}</span>°
              </span>
              <span className="text-text-secondary">
                period{" "}
                <span className="text-text-primary">{fmtFixed(result.target?.periodMinutes, 1)}</span> min
              </span>
              <span className="text-text-muted">
                {epochAgeLabel(result.target?.epoch, result.windowStart)}
              </span>
            </div>

            {/* Stats chips */}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatChip
                label="Candidates / sample"
                value={`${fmtInt(result.candidatesScreened)} / ${fmtInt(result.sampleSize)}`}
              />
              <StatChip label="SGP4 propagations" value={fmtInt(result.propagations)} />
              <StatChip label="Compute" value={`${fmtInt(result.computeMs)} ms`} />
              <StatChip
                label="Window (UTC)"
                value={`${fmtUtcIso(result.windowStart)} → ${fmtUtcIso(result.windowEnd)}`}
              />
            </div>

            {/* Assumptions */}
            {assumptionsLine && (
              <div className="font-mono text-[0.65rem] text-text-muted">
                Assumptions: {assumptionsLine} · coarse step{" "}
                {fmtFixed(a?.coarseStepSeconds, 0)} s · window {fmtFixed(a?.windowHours, 0)} h
              </div>
            )}

            {result.truncated && (
              <div className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 font-mono text-xs text-caution">
                Compute budget reached — {fmtInt(result.candidatesScreened)} candidates screened;
                rerun with a shorter window for full coverage.
              </div>
            )}

            {/* Table / clear */}
            {result.closeApproaches.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-left font-mono text-[0.65rem]">
                  <thead>
                    <tr className="text-[0.6rem] uppercase tracking-widest text-text-muted">
                      <th className="border-b border-glass px-2 py-1.5 font-normal">#</th>
                      <th className="border-b border-glass px-2 py-1.5 font-normal">Secondary</th>
                      <th className="border-b border-glass px-2 py-1.5 font-normal">TCA (UTC)</th>
                      <th className="border-b border-glass px-2 py-1.5 text-right font-normal">Miss km</th>
                      <th className="border-b border-glass px-2 py-1.5 text-right font-normal">Vrel km/s</th>
                      <th className="border-b border-glass px-2 py-1.5 text-right font-normal">Radial km</th>
                      <th className="border-b border-glass px-2 py-1.5 text-right font-normal">In-track km</th>
                      <th className="border-b border-glass px-2 py-1.5 text-right font-normal">Cross km</th>
                      <th className="border-b border-glass px-2 py-1.5 text-right font-normal">Pc</th>
                      <th className="border-b border-glass px-2 py-1.5 text-center font-normal">Box</th>
                      <th className="border-b border-glass px-2 py-1.5 font-normal">Severity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.closeApproaches.map((e, i) => (
                      <ApproachRow
                        key={`${e.noradId}-${e.tca}`}
                        index={i}
                        event={e}
                        nowMs={nowMs}
                      />
                    ))}
                  </tbody>
                </table>
                {hasCoOrbital && (
                  <div className="mt-1 font-mono text-[0.6rem] text-text-muted">
                    † co-orbital encounter (relative speed &lt; {CO_ORBITAL_VREL_KM_S} km/s): the
                    short-encounter Pc approximation is indicative only.
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-safe/40 bg-safe/10 px-3 py-2 font-mono text-xs text-text-primary">
                <span
                  className="rounded px-2 py-0.5 font-display text-[0.6rem] font-bold"
                  style={{ color: "#00FF41", border: "1px solid #00FF41" }}
                >
                  ✓ CLEAR
                </span>
                <span>
                  CLEAR SCREEN — no approaches within {result.assumptions?.reportThresholdKm ?? DEFAULT_SCREENING_OPTIONS.reportThresholdKm} km of{" "}
                  {result.target?.name || run?.target || "the target"} over the next {fmtFixed(resultHours, 0)} h.
                </span>
              </div>
            )}

            {/* AI assessment */}
            <div>
              <button
                type="button"
                data-testid="screen-assess"
                onClick={handleAssess}
                disabled={assessLoading}
                className="rounded border border-glass bg-white/5 px-2 py-1 font-mono text-[0.65rem] tracking-wide text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {assessLoading ? "Writing assessment memo…" : "▸ AI conjunction assessment"}
              </button>

              {assessLoading && (
                <div className="mt-2 font-mono text-xs text-text-secondary blink-cursor">
                  Claude is interpreting the screening numbers
                </div>
              )}

              {assessError && (
                <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
                  {assessError}
                </div>
              )}

              {memo && <MemoPanel memo={memo} />}
            </div>

            <div
              className="border-t pt-2 font-mono text-[0.6rem] leading-relaxed text-text-muted"
              style={{ borderColor: GLASS_BORDER }}
            >
              Screening on public two-line elements with an assumed covariance. Not an
              operational CDM — maneuver decisions require owner/operator ephemeris or an 18 SDS
              conjunction data message.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
