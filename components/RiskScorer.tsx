"use client";

import { useEffect, useState } from "react";
import type {
  ManeuverLevel,
  ManeuverPlan,
  ManeuverRequest,
  RiskScore,
  ThreatLevel,
} from "@/lib/prompts";

/* ============================================================
   Panel 2 — AI Risk Scorer

   Input a satellite name or NORAD ID -> POST /api/analyze ->
   render a RiskScore with animated score bars and an orbital
   data grid (CONTEXT.md Panel 2).

   Session 4 addition — Maneuver Recommendation Engine:
   MEDIUM / HIGH / CRITICAL results expose a GET MANEUVER PLAN
   button that POSTs to /api/maneuver and renders the 6-section
   plain-text plan in an amber/orange panel with a coloured
   RECOMMENDATION badge. The existing search flow, score bars,
   data grid, and animations are NOT touched.
   ============================================================ */

const QUICK_CHIPS = ["ISS", "HUBBLE", "STARLINK-1234", "25544", "NOAA 19"];

const THREAT_COLORS: Record<ThreatLevel, string> = {
  LOW: "#00FF41",
  MEDIUM: "#FFB800",
  HIGH: "#FF8A2B",
  CRITICAL: "#FF3131",
};

/** Maneuver badge colours — green/amber/orange/red by action level. */
const MANEUVER_REC_COLORS: Record<ManeuverLevel, string> = {
  MONITOR: "#00FF41",
  PREPARE: "#FFB800",
  EXECUTE: "#FF8A2B",
  EMERGENCY: "#FF3131",
};

/** Maneuver button only shows for these threats (per spec). */
const MANEUVER_ELIGIBLE: ReadonlySet<ThreatLevel> = new Set<ThreatLevel>([
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

/** Risk scale: low value = safe (green), high value = danger (red). */
function riskColor(value: number): string {
  if (value < 34) return "#00FF41";
  if (value < 67) return "#FFB800";
  return "#FF3131";
}

/** Stability scale: INVERTED — high value = stable (green). */
function stabilityColor(value: number): string {
  if (value > 66) return "#00FF41";
  if (value > 33) return "#FFB800";
  return "#FF3131";
}

/** A single labelled score bar that fills 0 -> value on load. */
function ScoreBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    // Next frame: animate from 0 to the real value.
    const id = requestAnimationFrame(() => setWidth(value));
    return () => cancelAnimationFrame(id);
  }, [value]);

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between font-mono text-xs">
        <span className="text-text-secondary uppercase tracking-wide">
          {label}
        </span>
        <span style={{ color }}>{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full transition-[width] duration-1000 ease-out"
          style={{ width: `${Math.max(0, Math.min(100, width))}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

/** A compact orbital-data cell. */
function DataCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-glass bg-white/5 px-3 py-2">
      <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div className="font-mono text-sm text-text-primary">{value}</div>
    </div>
  );
}

/**
 * Amber/orange-themed maneuver plan panel.
 * Strips the trailing RECOMMENDATION: line out of the body text
 * since we already render the action level as its own badge.
 */
function ManeuverPanel({ plan }: { plan: ManeuverPlan }) {
  const recColor = MANEUVER_REC_COLORS[plan.recommendation];
  const body = plan.text.replace(/RECOMMENDATION\s*:.*$/im, "").trim();
  const isEmergency = plan.recommendation === "EMERGENCY";

  return (
    <div
      className={`mt-3 rounded-md border p-3 ${isEmergency ? "animate-pulse-alert" : ""}`}
      style={{
        borderColor: "rgba(255, 138, 43, 0.6)", // amber/orange #FF8A2B at 60%
        backgroundColor: "rgba(255, 184, 0, 0.08)", // amber #FFB800 at 8%
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className="font-display text-[0.7rem] font-bold uppercase tracking-widest"
          style={{ color: "#FF8A2B" }}
        >
          ▸ Maneuver Plan
        </span>
        <span
          className="shrink-0 rounded px-2 py-0.5 font-display text-[0.65rem] font-bold"
          style={{ color: recColor, border: `1px solid ${recColor}` }}
        >
          {plan.recommendation}
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[0.65rem] leading-relaxed text-text-secondary">
        {body}
      </pre>
    </div>
  );
}

export default function RiskScorer() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RiskScore | null>(null);

  // ---- Maneuver-engine state (independent of the risk-scorer flow) ----
  const [maneuverLoading, setManeuverLoading] = useState(false);
  const [maneuverError, setManeuverError] = useState<string | null>(null);
  const [maneuver, setManeuver] = useState<ManeuverPlan | null>(null);

  async function analyze(rawQuery: string) {
    const q = rawQuery.trim();
    if (!q || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    // Clear any stale maneuver plan from the previous satellite.
    setManeuver(null);
    setManeuverError(null);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `Request failed (HTTP ${res.status}).`);
      }
      setResult(data as RiskScore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function getManeuverPlan() {
    if (!result || maneuverLoading) return;
    if (!MANEUVER_ELIGIBLE.has(result.overallThreat)) return;

    setManeuverLoading(true);
    setManeuverError(null);

    const body: ManeuverRequest = {
      satelliteName: result.tle?.OBJECT_NAME ?? query.trim() ?? "Unknown",
      noradId: result.tle?.NORAD_CAT_ID ?? "Unknown",
      altitudeKm: result.altitudeKm,
      periodMinutes: result.periodMinutes,
      inclinationDeg: result.inclinationDeg,
      collisionProbability: result.collisionProbability,
      debrisDensity: result.debrisDensity,
      orbitalStability: result.orbitalStability,
      overallThreat: result.overallThreat,
      closestApproach: result.closestApproach,
      tleLine1: result.tle?.TLE_LINE1,
      tleLine2: result.tle?.TLE_LINE2,
    };

    try {
      const res = await fetch("/api/maneuver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error ?? `Maneuver request failed (HTTP ${res.status}).`
        );
      }
      setManeuver(data as ManeuverPlan);
    } catch (err) {
      setManeuverError(
        err instanceof Error ? err.message : "Maneuver plan failed."
      );
    } finally {
      setManeuverLoading(false);
    }
  }

  const showManeuverButton =
    result !== null && MANEUVER_ELIGIBLE.has(result.overallThreat);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* ---- Search ---- */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          analyze(query);
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Satellite name or NORAD ID…"
          className="flex-1 rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-safe focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md border border-safe/40 bg-safe/10 px-4 py-2 font-mono text-sm font-semibold text-safe transition-colors hover:bg-safe/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "…" : "SCORE"}
        </button>
      </form>

      {/* ---- Quick chips ---- */}
      <div className="flex flex-wrap gap-2">
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip}
            onClick={() => {
              setQuery(chip);
              analyze(chip);
            }}
            disabled={loading}
            className="rounded-full border border-glass bg-white/5 px-3 py-1 font-mono text-[0.7rem] text-text-secondary transition-colors hover:border-safe/40 hover:text-safe disabled:opacity-50"
          >
            {chip}
          </button>
        ))}
      </div>

      {/* ---- States ---- */}
      {loading && (
        <div className="font-mono text-xs text-text-secondary blink-cursor">
          Querying Space-Track + Claude
        </div>
      )}

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {/* ---- Result ---- */}
      {result && (
        <div className="flex flex-col gap-4 overflow-y-auto">
          {/* Threat badge */}
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs uppercase tracking-widest text-text-muted">
              Overall threat
            </span>
            <span
              className={`rounded-md px-3 py-1 font-display text-sm font-bold ${
                result.overallThreat === "CRITICAL" ? "animate-pulse-alert" : ""
              }`}
              style={{
                color: THREAT_COLORS[result.overallThreat],
                border: `1px solid ${THREAT_COLORS[result.overallThreat]}`,
              }}
            >
              {result.overallThreat}
            </span>
          </div>

          {/* Score bars */}
          <div>
            <ScoreBar
              label="Collision probability"
              value={result.collisionProbability}
              color={riskColor(result.collisionProbability)}
            />
            <ScoreBar
              label="Debris density"
              value={result.debrisDensity}
              color={riskColor(result.debrisDensity)}
            />
            <ScoreBar
              label="Orbital stability"
              value={result.orbitalStability}
              color={stabilityColor(result.orbitalStability)}
            />
          </div>

          {/* Maneuver trigger — MEDIUM / HIGH / CRITICAL only.
              Sits below the score bars (per spec) and above the
              orbital data so it's the most prominent next-action. */}
          {showManeuverButton && (
            <div>
              <button
                type="button"
                onClick={getManeuverPlan}
                disabled={maneuverLoading}
                className="w-full rounded border px-2 py-1.5 font-display text-[0.65rem] font-bold uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  color: "#FF8A2B",
                  borderColor: "rgba(255, 138, 43, 0.6)",
                  backgroundColor: "rgba(255, 184, 0, 0.1)",
                }}
              >
                {maneuverLoading
                  ? "Computing maneuver plan…"
                  : maneuver
                    ? "↻ Re-run maneuver plan"
                    : "▸ Get maneuver plan"}
              </button>

              {maneuverError && (
                <div className="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 font-mono text-[0.65rem] text-danger">
                  {maneuverError}
                </div>
              )}

              {maneuver && <ManeuverPanel plan={maneuver} />}
            </div>
          )}

          {/* Orbital data grid */}
          <div className="grid grid-cols-3 gap-2">
            <DataCell label="Altitude" value={`${result.altitudeKm} km`} />
            <DataCell label="Period" value={`${result.periodMinutes} min`} />
            <DataCell label="Inclination" value={`${result.inclinationDeg}°`} />
          </div>

          {/* Closest approach */}
          <div className="rounded-md border border-glass bg-white/5 px-3 py-2">
            <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
              Closest approach
            </div>
            <div className="font-mono text-sm text-text-primary">
              {result.closestApproach}
            </div>
          </div>

          {/* Recommendation */}
          <div>
            <div className="mb-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
              Recommended maneuver
            </div>
            <p className="font-mono text-xs leading-relaxed text-text-primary">
              {result.recommendation}
            </p>
          </div>

          {/* Summary */}
          <div>
            <div className="mb-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
              Summary
            </div>
            <p className="font-mono text-xs leading-relaxed text-text-secondary">
              {result.summary}
            </p>
          </div>
        </div>
      )}

      {/* ---- Empty state ---- */}
      {!loading && !error && !result && (
        <div className="mt-4 font-mono text-xs text-text-muted">
          Enter a satellite name or NORAD ID, or tap a chip above, to generate a
          live AI collision-risk assessment.
        </div>
      )}
    </div>
  );
}
