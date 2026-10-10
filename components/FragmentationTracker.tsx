"use client";

import { useEffect, useMemo, useState } from "react";
import { getDebrisSample } from "@/lib/debrisClient";
import { formatUtcTime } from "@/lib/orbital";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import {
  BREAKUP_CATALOG,
  groupFamilies,
  type BreakupType,
  type DebrisFamily,
  type FamilyReport,
} from "@/lib/fragmentation";

/* ============================================================
   Panel — Fragmentation Family Tracker

   ODPO-style breakup attribution of the live Space-Track sample.

   Data flow
   - Reads the shared browser-side sample from lib/debrisClient
     (getDebrisSample) — the same 2,000 gp rows the 3D map draws,
     so mounting this panel costs no extra Space-Track request
     beyond the one /api/debris round trip the sample already
     shares (served from the route's 10-minute server cache).
   - All grouping / attribution is deterministic and runs in the
     browser via lib/fragmentation groupFamilies(). No Claude call.

   Cache / refresh cadence
   - No polling. The sample lives in lib/debrisClient's 10-minute
     BROWSER cache; the header ↻ button calls getDebrisSample(true)
     to bypass that cache and re-request GET /api/debris. The route
     keeps its own 10-minute SERVER cache with no bust parameter (it
     guards the Space-Track rate limit), so a click can legitimately
     return the identical sample — the button tooltip says exactly
     that instead of claiming a fresh Space-Track pull.
   - Every fetch runs inside a useEffect keyed on a request nonce
     with a cancelled flag, so a refresh click never sets state
     on an unmounted panel.

   Assumptions shown on screen (footnote)
   - Sample = 2,000 most-recently-updated element sets in the gp
     class, NOT the full catalog. Family counts describe the
     sample only.
   - Fragment totals are approximate cataloged counts from public
     NASA ODPO / ESA reporting, labelled "approx".
   - Attribution is two-factor: launch designator AND parent-name
     pattern must both match.
   - Stat cells are computed over the WHOLE sample (every launch
     group, singletons included); the table shows only the top
     MAX_FAMILIES multi-object families, so the two can differ.
   ============================================================ */

const MAX_FAMILIES = 10;
const EVENT_NOTE_COUNT = 3;

/** Breakup-type badge colours (project palette + muted grey for UNKNOWN). */
const BREAKUP_TYPE_COLORS: Record<BreakupType, string> = {
  ASAT: "#FF3131",
  COLLISION: "#FF8A2B",
  EXPLOSION: "#FFB800",
  ANOMALOUS: "#FFB800",
  UNKNOWN: "#888888",
};

const BAR_FILL = "rgba(0,255,65,0.45)";

/* ------------------------------------------------------------
   Formatting guards — never render NaN / undefined / "null".
   ------------------------------------------------------------ */

function fmtInt(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.round(n).toLocaleString()
    : "—";
}

function fmtKm(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n)
    ? `${Math.round(n).toLocaleString()} km`
    : "—";
}

function fmtDeg1(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(1)}°` : "—";
}

/** numerator / denominator as a percentage string; "—" when undefined. */
function fmtPct(num: number, den: number, digits: number): string {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return "—";
  return `${((num / den) * 100).toFixed(digits)}%`;
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
      <div className="mt-0.5 font-mono text-[0.65rem] text-text-secondary">
        {sub}
      </div>
    </div>
  );
}

function EventBadge({ type }: { type: BreakupType }) {
  const color = BREAKUP_TYPE_COLORS[type];
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 font-display text-[0.6rem] font-bold leading-none"
      style={{ color, border: `1px solid ${color}` }}
    >
      {type}
    </span>
  );
}

function FamilyRow({
  index,
  family,
  topCount,
}: {
  index: number;
  family: DebrisFamily;
  topCount: number;
}) {
  const pct =
    topCount > 0
      ? Math.max(0, Math.min(100, (family.count / topCount) * 100))
      : 0;
  const event = family.event;

  return (
    <tr
      data-testid="fragmentation-row"
      className="border-b border-glass align-top last:border-b-0 hover:bg-white/5"
      title={event ? event.note : undefined}
    >
      <td className="whitespace-nowrap py-2 pr-3 text-text-muted">
        {index + 1}
      </td>

      <td className="py-2 pr-3">
        <div className="text-text-primary">{family.parentName}</div>
        <div className="text-text-muted">{family.launchDesignator}</div>
      </td>

      <td className="whitespace-nowrap py-2 pr-3">
        {event ? (
          <>
            <EventBadge type={event.eventType} />
            <div className="mt-1 text-text-secondary">{event.eventDate}</div>
          </>
        ) : (
          <span className="text-text-muted">unattributed</span>
        )}
      </td>

      <td className="py-2 pr-3">
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-text-primary">{fmtInt(family.count)}</span>
          <span className="text-text-muted">
            {fmtInt(family.debrisCount)} deb
          </span>
        </div>
        <div className="mt-1 h-[6px] w-full min-w-[80px] overflow-hidden rounded-sm bg-white/5">
          <div
            className="h-full rounded-sm"
            style={{ width: `${pct}%`, backgroundColor: BAR_FILL }}
          />
        </div>
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right text-text-secondary">
        {fmtKm(family.meanAltitudeKm)}
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right text-text-secondary">
        {fmtDeg1(family.meanInclinationDeg)}
      </td>

      <td className="whitespace-nowrap py-2 text-text-secondary">
        {family.shell ?? "—"}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------
   Panel
   ------------------------------------------------------------ */

interface SampleRequest {
  nonce: number;
  force: boolean;
}

export default function FragmentationTracker() {
  const [objects, setObjects] = useState<SpaceTrackTLE[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Every fetch is driven by this request record so the ↻ button only
  // bumps state and the effect below (with its cancelled flag) does the I/O.
  const [request, setRequest] = useState<SampleRequest>({
    nonce: 0,
    force: false,
  });

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
          err instanceof Error
            ? err.message
            : "Failed to load the Space-Track sample."
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

  const report: FamilyReport | null = useMemo(
    () => (objects ? groupFamilies(objects, MAX_FAMILIES) : null),
    [objects]
  );

  const topCount = report && report.families.length > 0 ? report.families[0].count : 0;

  const noteFamilies = useMemo(
    () =>
      report
        ? report.families.filter((f) => f.event !== null).slice(0, EVENT_NOTE_COUNT)
        : [],
    [report]
  );

  const handleRefresh = () => {
    setRequest((r) => ({ nonce: r.nonce + 1, force: true }));
  };

  return (
    <section
      className="glass-card overflow-hidden"
      data-testid="fragmentation-tracker"
    >
      {/* Header */}
      <div className="flex h-9 items-center justify-between border-b border-glass px-3">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          FRAGMENTATION FAMILY TRACKER
        </h2>
        <div className="flex items-center gap-3 font-mono text-[0.65rem] text-text-muted">
          {report ? (
            <span>
              sample{" "}
              <span className="text-text-secondary">
                {/* Plain integer on purpose ("sample N obj"), not
                    locale-grouped like the stat cells. */}
                {String(report.totalObjects)}
              </span>{" "}
              obj ·{" "}
              <span className="text-text-secondary">
                {fmtPct(report.debrisObjects, report.totalObjects, 0)}
              </span>{" "}
              debris
            </span>
          ) : (
            <span>sample —</span>
          )}
          {fetchedAt && (
            <span className="hidden sm:inline">
              upd {formatUtcTime(fetchedAt)}Z
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            aria-label="Refresh sample"
            title="Re-request the sample (server refreshes from Space-Track every 10 min)"
            data-testid="fragmentation-refresh"
            className="rounded border border-glass bg-white/5 px-2 py-1 font-mono text-[0.65rem] tracking-wide text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="p-4">
        {/* ---- States ---- */}
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCell
                label="DEBRIS IN SAMPLE"
                value={fmtInt(report.debrisObjects)}
                sub={`${fmtPct(report.debrisObjects, report.totalObjects, 1)} of ${fmtInt(
                  report.totalObjects
                )} objects`}
                accent="#FFB800"
              />
              <StatCell
                label="ATTRIBUTED TO KNOWN BREAKUPS"
                value={fmtInt(report.attributedDebrisObjects)}
                sub={`${fmtPct(
                  report.attributedDebrisObjects,
                  report.debrisObjects,
                  1
                )} of debris · designator + name match`}
                accent="#FF8A2B"
              />
              <StatCell
                label="BREAKUP EVENTS PRESENT"
                value={fmtInt(report.catalogEventsPresent)}
                sub={`of ${BREAKUP_CATALOG.length} cataloged ODPO / ESA events`}
                accent="#00FF41"
              />
            </div>

            {/* ---- Family table ---- */}
            <div>
              <div className="mb-2 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                Top {MAX_FAMILIES} fragmentation families · debris-bearing first
              </div>
              {report.families.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse font-mono text-[0.65rem]">
                    <thead>
                      <tr className="border-b border-glass text-left font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                        <th scope="col" className="py-1.5 pr-3 font-normal">
                          #
                        </th>
                        <th scope="col" className="py-1.5 pr-3 font-normal">
                          PARENT
                        </th>
                        <th scope="col" className="py-1.5 pr-3 font-normal">
                          EVENT
                        </th>
                        <th scope="col" className="py-1.5 pr-3 font-normal">
                          OBJECTS
                        </th>
                        <th
                          scope="col"
                          className="py-1.5 pr-3 text-right font-normal"
                        >
                          MEAN ALT
                        </th>
                        <th
                          scope="col"
                          className="py-1.5 pr-3 text-right font-normal"
                        >
                          MEAN INCL
                        </th>
                        <th scope="col" className="py-1.5 font-normal">
                          SHELL
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.families.map((f, i) => (
                        <FamilyRow
                          key={f.launchDesignator}
                          index={i}
                          family={f}
                          topCount={topCount}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="font-mono text-xs text-text-muted">
                  No multi-object launch families in the current sample.
                </div>
              )}
            </div>

            {/* ---- Event notes (top 3 attributed families) ---- */}
            {noteFamilies.length > 0 && (
              <div>
                <div className="mb-2 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                  EVENT NOTES
                </div>
                <ul className="flex flex-col gap-1.5">
                  {noteFamilies.map((f) => {
                    // noteFamilies is filtered on event !== null above, so
                    // this guard is only for the type system.
                    if (!f.event) return null;
                    const color = BREAKUP_TYPE_COLORS[f.event.eventType];
                    return (
                      <li
                        key={f.launchDesignator}
                        className="rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-[0.65rem] leading-relaxed"
                      >
                        <span className="text-text-primary">
                          {f.event.parentName}
                        </span>
                        <span className="text-text-muted">
                          {" "}
                          · {f.event.launchDesignator} ·{" "}
                        </span>
                        <span className="font-display font-bold" style={{ color }}>
                          {f.event.eventType}
                        </span>
                        <span className="text-text-muted">
                          {" "}
                          · {f.event.eventDate} · approx{" "}
                          {fmtInt(f.event.approxCatalogedFragments)} cataloged
                          fragments at approx {fmtKm(f.event.approxAltitudeKm)} ·{" "}
                          {fmtInt(f.count)} in sample
                        </span>
                        <div className="text-text-secondary">{f.event.note}</div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* ---- Footnote / assumptions ---- */}
            <p className="font-mono text-[0.6rem] leading-relaxed text-text-muted">
              Sample = the 2,000 most-recently-updated element sets in
              Space-Track&apos;s gp class, not the full catalog. Fragment totals
              are approximate cataloged counts from public NASA ODPO / ESA
              reporting. Attribution requires BOTH the launch designator and a
              parent-name match; mean altitude = (apoapsis + periapsis) / 2 from
              the gp fields. Stat cells are computed over the whole sample; the
              table ranks families that carry cataloged debris (or a known
              breakup) first and lists at most {MAX_FAMILIES}; intact launch
              batches only appear when the sample holds fewer than three such
              families.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
