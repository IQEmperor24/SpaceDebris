"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CascadeSimulation,
  CascadeStatus,
  ConjunctionAlert,
  ThreatLevel,
} from "@/lib/prompts";

/* ============================================================
   Panel 3 — Collision Alert Feed

   GET /api/conjunctions every 60s (matches server cache), with a
   live countdown. Each alert shows the two objects, miss distance,
   probability, time-to-TCA, and the AI recommendation. CRITICAL
   alerts pulse red. (CONTEXT.md Panel 3.)

   Session 4 addition — Kessler cascade simulator:
   MEDIUM / HIGH / CRITICAL cards expose a SIMULATE CASCADE button
   that POSTs to /api/cascade and renders the 5-section narrative
   in a red panel below the card body. The existing 60s fetch loop,
   countdown ticker, and card layout are NOT touched.

   ---- React key — IMPORTANT ----
   Space-Track reuses CDM_ID across revisions of the same conjunction,
   so `key={alert.cdmId}` collapsed distinct cards onto a single
   mounted component (React dedupes duplicate keys and reuses state
   across rerenders). That made the cascade state visibly leak from
   one card to another. The composite key below uses the same event
   identity tuple the server now uses for its cascade cache —
   guaranteeing one mounted card per distinct conjunction event.
   ============================================================ */

const REFRESH_SECONDS = 60;

const URGENCY_COLORS: Record<ThreatLevel, string> = {
  LOW: "#00FF41",
  MEDIUM: "#FFB800",
  HIGH: "#FF8A2B",
  CRITICAL: "#FF3131",
};

const CASCADE_STATUS_COLORS: Record<CascadeStatus, string> = {
  CONTAINED: "#00FF41",
  WARNING: "#FFB800",
  CRITICAL: "#FF8A2B",
  CATASTROPHIC: "#FF3131",
};

/** Cascade button only on MEDIUM, HIGH, CRITICAL (per spec). */
const CASCADE_ELIGIBLE: ReadonlySet<ThreatLevel> = new Set<ThreatLevel>([
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

/** Stable per-event identity — matches the server's cascade cache key. */
function alertKey(a: ConjunctionAlert): string {
  return [
    a.cdmId,
    a.sat1Id,
    a.sat2Id,
    a.tca,
    a.missDistanceKm,
    a.probability,
  ].join("|");
}

/** Human-readable time until the closest approach. */
function formatTimeToTca(tca: string): string {
  const t = new Date(tca).getTime();
  if (Number.isNaN(t)) return tca; // unparseable -> show raw
  const diffMs = t - Date.now();
  if (diffMs <= 0) return "imminent / passed";
  const hours = diffMs / 3_600_000;
  if (hours < 1) return `${Math.round(diffMs / 60_000)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

/**
 * Red-themed cascade narrative panel.
 * Strips the trailing CASCADE STATUS: line out of the body text
 * since we already render the status as its own badge.
 */
function CascadePanel({ cascade }: { cascade: CascadeSimulation }) {
  const statusColor = CASCADE_STATUS_COLORS[cascade.status];
  const body = cascade.text.replace(/CASCADE\s*STATUS\s*:.*$/im, "").trim();

  return (
    <div className="mt-3 rounded-md border border-danger/60 bg-danger/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-display text-[0.7rem] font-bold uppercase tracking-widest text-danger">
          ▸ Kessler Cascade Simulation
        </span>
        <span
          className="shrink-0 rounded px-2 py-0.5 font-display text-[0.65rem] font-bold"
          style={{ color: statusColor, border: `1px solid ${statusColor}` }}
        >
          {cascade.status}
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[0.65rem] leading-relaxed text-text-secondary">
        {body}
      </pre>
    </div>
  );
}

function AlertCard({ alert }: { alert: ConjunctionAlert }) {
  const color = URGENCY_COLORS[alert.urgency];
  const isCritical = alert.urgency === "CRITICAL";
  const showCascadeButton = CASCADE_ELIGIBLE.has(alert.urgency);

  // Per-card cascade state — never lifted, so the existing feed
  // fetch loop in the parent never re-renders these on its tick.
  const [cascadeLoading, setCascadeLoading] = useState(false);
  const [cascadeError, setCascadeError] = useState<string | null>(null);
  const [cascade, setCascade] = useState<CascadeSimulation | null>(null);

  const runCascade = useCallback(async () => {
    setCascadeLoading(true);
    setCascadeError(null);
    try {
      const res = await fetch("/api/cascade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cdmId: alert.cdmId,
          sat1Name: alert.sat1Name,
          sat1Id: alert.sat1Id,
          sat2Name: alert.sat2Name,
          sat2Id: alert.sat2Id,
          tca: alert.tca,
          missDistanceKm: alert.missDistanceKm,
          probability: alert.probability,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error ?? `Cascade request failed (HTTP ${res.status}).`
        );
      }
      setCascade(data as CascadeSimulation);
    } catch (err) {
      setCascadeError(
        err instanceof Error ? err.message : "Cascade simulation failed."
      );
    } finally {
      setCascadeLoading(false);
    }
  }, [alert]);

  return (
    <div
      className={`rounded-md border bg-white/5 p-3 ${
        isCritical ? "animate-pulse-alert" : ""
      }`}
      style={{ borderColor: isCritical ? "#FF3131" : "rgba(255,255,255,0.08)" }}
    >
      {/* Objects + urgency */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="font-mono text-xs text-text-primary">
          <span className="font-semibold">{alert.sat1Name}</span>
          <span className="text-text-muted"> ↔ </span>
          <span className="font-semibold">{alert.sat2Name}</span>
        </div>
        <span
          className="shrink-0 rounded px-2 py-0.5 font-display text-[0.65rem] font-bold"
          style={{ color, border: `1px solid ${color}` }}
        >
          {alert.urgency}
        </span>
      </div>

      {/* Metrics */}
      <div className="mb-2 grid grid-cols-3 gap-2 font-mono text-[0.65rem]">
        <div>
          <div className="uppercase tracking-widest text-text-muted">TCA</div>
          <div className="text-text-primary">{formatTimeToTca(alert.tca)}</div>
        </div>
        <div>
          <div className="uppercase tracking-widest text-text-muted">Miss</div>
          <div className="text-text-primary">{alert.missDistanceKm} km</div>
        </div>
        <div>
          <div className="uppercase tracking-widest text-text-muted">Prob</div>
          <div className="text-text-primary">{alert.probability}</div>
        </div>
      </div>

      {/* AI summary + recommendation */}
      <p className="mb-1 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        {alert.plainEnglish}
      </p>
      <p className="font-mono text-[0.7rem] leading-relaxed" style={{ color }}>
        ▸ {alert.recommendation}
      </p>

      {/* Cascade trigger — MEDIUM / HIGH / CRITICAL only */}
      {showCascadeButton && (
        <button
          type="button"
          onClick={runCascade}
          disabled={cascadeLoading}
          className="mt-3 w-full rounded border border-danger/60 bg-danger/10 px-2 py-1.5 font-display text-[0.65rem] font-bold uppercase tracking-widest text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cascadeLoading
            ? "Simulating cascade…"
            : cascade
              ? "↻ Re-run cascade simulation"
              : "▸ Simulate Kessler cascade"}
        </button>
      )}

      {cascadeError && (
        <div className="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 font-mono text-[0.65rem] text-danger">
          {cascadeError}
        </div>
      )}

      {cascade && <CascadePanel cascade={cascade} />}
    </div>
  );
}

export default function AlertFeed() {
  const [alerts, setAlerts] = useState<ConjunctionAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/conjunctions");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `Request failed (HTTP ${res.status}).`);
      }
      setAlerts((data.alerts as ConjunctionAlert[]) ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts.");
    } finally {
      setLoading(false);
      setCountdown(REFRESH_SECONDS); // re-sync countdown to the real fetch
    }
  }, []);

  useEffect(() => {
    fetchAlerts();

    // 60s fetch loop + 1s display tick (kept independent on purpose).
    const fetchTimer = setInterval(fetchAlerts, REFRESH_SECONDS * 1000);
    const tickTimer = setInterval(
      () => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)),
      1000
    );

    return () => {
      clearInterval(fetchTimer);
      clearInterval(tickTimer);
    };
  }, [fetchAlerts]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Header */}
      <div className="flex items-center justify-between font-mono text-[0.7rem] text-text-muted">
        <span className="uppercase tracking-widest">
          {alerts.length} active conjunction{alerts.length === 1 ? "" : "s"}
        </span>
        <span>
          refresh in <span className="text-safe">{countdown}s</span>
        </span>
      </div>

      {/* States */}
      {loading && alerts.length === 0 && (
        <div className="font-mono text-xs text-text-secondary blink-cursor">
          Fetching conjunction data
        </div>
      )}

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {!loading && !error && alerts.length === 0 && (
        <div className="font-mono text-xs text-text-muted">
          No active conjunction alerts right now. The feed refreshes every{" "}
          {REFRESH_SECONDS}s.
        </div>
      )}

      {/* Feed */}
      <div className="flex flex-col gap-3 overflow-y-auto">
        {alerts.map((alert) => (
          <AlertCard key={alertKey(alert)} alert={alert} />
        ))}
      </div>
    </div>
  );
}
