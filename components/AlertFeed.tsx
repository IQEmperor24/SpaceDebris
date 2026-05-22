"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConjunctionAlert, ThreatLevel } from "@/lib/prompts";

/* ============================================================
   Panel 3 — Collision Alert Feed

   GET /api/conjunctions every 60s (matches server cache), with a
   live countdown. Each alert shows the two objects, miss distance,
   probability, time-to-TCA, and the AI recommendation. CRITICAL
   alerts pulse red. (CONTEXT.md Panel 3.)
   ============================================================ */

const REFRESH_SECONDS = 60;

const URGENCY_COLORS: Record<ThreatLevel, string> = {
  LOW: "#00FF41",
  MEDIUM: "#FFB800",
  HIGH: "#FF8A2B",
  CRITICAL: "#FF3131",
};

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

function AlertCard({ alert }: { alert: ConjunctionAlert }) {
  const color = URGENCY_COLORS[alert.urgency];
  const isCritical = alert.urgency === "CRITICAL";

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
          <AlertCard key={alert.cdmId} alert={alert} />
        ))}
      </div>
    </div>
  );
}
