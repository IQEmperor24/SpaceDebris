"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  FleetIntelligence,
  FleetTopThreat,
  RiskTrend,
  ShellStatus,
  ThreatLevel,
} from "@/lib/prompts";

/* ============================================================
   Panel 4 — Fleet Intelligence Dashboard

   GET /api/fleet every 120s (matches the server's 2-min cache),
   with a live countdown. Renders:

   - 4 stat cards: total objects / active conjunctions /
     high-priority / critical
   - 3 shell bars (LEO / MEO / GEO) with NOMINAL/ELEVATED/
     CRITICAL status badges
   - Top 3 threats with severity-coloured badges + AI reasoning
   - AI executive brief (NASA Administrator audience)
   - 3 recommended actions
   - Risk trend indicator in the header

   Sits BELOW the existing 3-panel grid in app/page.tsx — does
   not touch or share state with OrbitalMap, RiskScorer, or
   AlertFeed.
   ============================================================ */

const REFRESH_SECONDS = 120;

const SHELL_STATUS_COLORS: Record<ShellStatus, string> = {
  NOMINAL: "#00FF41",
  ELEVATED: "#FFB800",
  CRITICAL: "#FF3131",
};

/**
 * Bar fill represents STATUS SEVERITY, not raw count.
 *
 * Counts vary by 1-2 orders of magnitude (LEO ~1800 vs GEO ~130
 * vs MEO ~50). Scaling by count would make MEO/GEO invisible
 * even when they're elevated. Status-driven fill keeps the bar
 * semantically meaningful — "how concerned should you be"
 * rather than "how many things are there".
 */
const SHELL_STATUS_FILL: Record<ShellStatus, number> = {
  NOMINAL: 35,
  ELEVATED: 70,
  CRITICAL: 100,
};

const THREAT_COLORS: Record<ThreatLevel, string> = {
  LOW: "#00FF41",
  MEDIUM: "#FFB800",
  HIGH: "#FF8A2B",
  CRITICAL: "#FF3131",
};

const TREND_META: Record<
  RiskTrend,
  { color: string; arrow: string; label: string }
> = {
  IMPROVING: { color: "#00FF41", arrow: "↘", label: "IMPROVING" },
  STABLE: { color: "#FFB800", arrow: "→", label: "STABLE" },
  DETERIORATING: { color: "#FF3131", arrow: "↗", label: "DETERIORATING" },
};

function StatCard({
  label,
  value,
  accent,
  pulse,
}: {
  label: string;
  value: string | number;
  accent: string;
  pulse?: boolean;
}) {
  return (
    <div
      className={`rounded-md border bg-white/5 p-3 ${
        pulse ? "animate-pulse-alert" : ""
      }`}
      style={{ borderColor: pulse ? "#FF3131" : "rgba(255,255,255,0.08)" }}
    >
      <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div
        className="mt-1 font-display text-2xl font-bold leading-tight"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}

function ShellBar({
  name,
  count,
  status,
}: {
  name: string;
  count: number;
  status: ShellStatus;
}) {
  const color = SHELL_STATUS_COLORS[status];
  const targetWidth = SHELL_STATUS_FILL[status];
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const id = requestAnimationFrame(() => setWidth(targetWidth));
    return () => cancelAnimationFrame(id);
  }, [targetWidth]);

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center justify-between font-mono text-xs">
        <span className="uppercase tracking-wide text-text-secondary">
          {name} · {count.toLocaleString()} obj
        </span>
        <span className="font-display font-bold" style={{ color }}>
          {status}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full transition-[width] duration-1000 ease-out"
          style={{
            width: `${Math.max(0, Math.min(100, width))}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

function TopThreatRow({
  index,
  threat,
}: {
  index: number;
  threat: FleetTopThreat;
}) {
  const color = THREAT_COLORS[threat.severity];
  const isCritical = threat.severity === "CRITICAL";
  return (
    <div
      className={`rounded-md border bg-white/5 p-3 ${
        isCritical ? "animate-pulse-alert" : ""
      }`}
      style={{
        borderColor: isCritical ? "#FF3131" : "rgba(255,255,255,0.08)",
      }}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="font-mono text-xs text-text-primary">
          <span className="text-text-muted">#{index + 1}</span> {threat.name}
        </span>
        <span
          className="shrink-0 rounded px-2 py-0.5 font-display text-[0.6rem] font-bold"
          style={{ color, border: `1px solid ${color}` }}
        >
          {threat.severity}
        </span>
      </div>
      <p className="font-mono text-[0.65rem] leading-relaxed text-text-secondary">
        {threat.reasoning}
      </p>
    </div>
  );
}

export default function FleetDashboard() {
  const [intel, setIntel] = useState<FleetIntelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);

  const fetchIntel = useCallback(async () => {
    try {
      const res = await fetch("/api/fleet");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `Request failed (HTTP ${res.status}).`);
      }
      setIntel(data as FleetIntelligence);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load fleet intel."
      );
    } finally {
      setLoading(false);
      setCountdown(REFRESH_SECONDS);
    }
  }, []);

  useEffect(() => {
    fetchIntel();

    const fetchTimer = setInterval(fetchIntel, REFRESH_SECONDS * 1000);
    const tickTimer = setInterval(
      () => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)),
      1000
    );

    return () => {
      clearInterval(fetchTimer);
      clearInterval(tickTimer);
    };
  }, [fetchIntel]);

  const trend = intel ? TREND_META[intel.riskTrend] : null;

  return (
    <section className="glass-card overflow-hidden">
      {/* Header — matches the 3-panel headings + trend indicator */}
      <div className="flex h-9 items-center justify-between border-b border-glass px-3">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          FLEET INTELLIGENCE
        </h2>
        <div className="flex items-center gap-4 font-mono text-[0.65rem] text-text-muted">
          {trend && (
            <span
              className="font-display font-bold"
              style={{ color: trend.color }}
            >
              TREND {trend.arrow} {trend.label}
            </span>
          )}
          <span>
            refresh in <span className="text-safe">{countdown}s</span>
          </span>
        </div>
      </div>

      <div className="p-4">
        {/* ---- States ---- */}
        {loading && !intel && (
          <div className="font-mono text-xs text-text-secondary blink-cursor">
            Synthesizing fleet intelligence
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {error}
          </div>
        )}

        {/* ---- Brief ---- */}
        {intel && (
          <div className="flex flex-col gap-5">
            {/* 4 stat cards */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard
                label="Total objects"
                value={intel.totalObjects.toLocaleString()}
                accent="#00FF41"
              />
              <StatCard
                label="Active conjunctions"
                value={intel.activeConjunctions.toLocaleString()}
                accent="#FFB800"
              />
              <StatCard
                label="High priority"
                value={intel.highPriorityCount.toLocaleString()}
                accent="#FF8A2B"
              />
              <StatCard
                label="Critical"
                value={intel.criticalCount.toLocaleString()}
                accent="#FF3131"
                pulse={intel.criticalCount > 0}
              />
            </div>

            {/* Shell bars */}
            <div>
              <div className="mb-2 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                Orbital shell status
              </div>
              <ShellBar
                name="LEO"
                count={intel.shells.leo.count}
                status={intel.shells.leo.status}
              />
              <ShellBar
                name="MEO"
                count={intel.shells.meo.count}
                status={intel.shells.meo.status}
              />
              <ShellBar
                name="GEO"
                count={intel.shells.geo.count}
                status={intel.shells.geo.status}
              />
            </div>

            {/* Threats + brief/actions */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Top threats */}
              <div>
                <div className="mb-2 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                  Top 3 threats
                </div>
                {intel.topThreats.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {intel.topThreats.map((t, i) => (
                      <TopThreatRow
                        key={`${i}-${t.name}`}
                        index={i}
                        threat={t}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="font-mono text-xs text-text-muted">
                    No top threats identified in the current window.
                  </div>
                )}
              </div>

              {/* Brief + actions */}
              <div className="flex flex-col gap-4">
                <div>
                  <div className="mb-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                    Executive brief — NASA Administrator
                  </div>
                  <p className="font-mono text-xs leading-relaxed text-text-secondary">
                    {intel.executiveBrief}
                  </p>
                </div>

                <div>
                  <div className="mb-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                    Recommended actions
                  </div>
                  {intel.recommendedActions.length > 0 ? (
                    <ol className="list-inside list-decimal font-mono text-xs leading-relaxed text-text-primary">
                      {intel.recommendedActions.map((a, i) => (
                        <li key={i} className="mb-1">
                          {a}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="font-mono text-xs text-text-muted">
                      No actions recommended at this time.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
