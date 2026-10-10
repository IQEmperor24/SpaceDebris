import { NextResponse } from "next/server";
import { ISS_NORAD_ID } from "@/lib/orbital";
import { ISS_CDM_SCAN_LIMIT, isIssCdm, type IssStatus } from "@/lib/iss";
import {
  fetchConjunctions,
  searchTLE,
  type SpaceTrackCDM,
  type SpaceTrackTLE,
} from "@/lib/spacetrack";

/* ============================================================
   GET /api/iss

   ISS TOPO Console data feed (Session 5, Feature 3).

   Flow:
   1. Promise.allSettled([
        searchTLE("25544")      -> latest ISS element set (gp class)
        fetchConjunctions(100)  -> upcoming public CDMs (cdm_public)
      ])
   2. Keep only CDMs where SAT_1_ID or SAT_2_ID is 25544 (isIssCdm).
   3. Return IssStatus — HTTP 200 even if ONE source failed, with
      the failure message in errors.tle / errors.cdms so the client
      can degrade gracefully (e.g. show the ground track but flag
      the CDM feed as unavailable). HTTP 503 { error, detail } only
      when BOTH sources failed.

   ---- Public CDM caveat (read before "fixing" an empty list) ----
   Space-Track's cdm_public class carries only the conjunction data
   messages that owner/operators have agreed to release publicly.
   ISS messages may or may not appear in it at any given time, so an
   EMPTY cdms array is a valid NOMINAL state — "no public ISS CDMs
   in the feed" — NOT an error. Official ISS CA is run by the NASA
   TOPO / CARA desks against 18 SDS data the public feed never sees.

   ---- Scan-window caveat ----
   fetchConjunctions(N) returns the N soonest-TCA messages CATALOGUE-
   WIDE (TCA > now, ordered by TCA asc) — it has no per-object
   predicate — and only then do we filter for 25544. cdm_public
   routinely holds thousands of future-TCA rows, so the soonest
   ISS_CDM_SCAN_LIMIT typically span only hours; an ISS CDM with a
   TCA a day or two out (the normal DAM planning lead time) can lie
   beyond that window and will NOT appear here. The console states
   this next to the NOMINAL badge. A per-object Space-Track query
   (SAT_1_ID/25544 or SAT_2_ID/25544 predicate) belongs in
   lib/spacetrack.ts and is out of scope for this feature.

   Cache: in-memory Map, single key.
   - Full success             -> 5 min (matches the 300 s client poll).
   - Partial failure (200)    -> 60 s, so we neither hammer Space-Track
                                 (30 req/min limit) nor pin a transient
                                 outage on screen for five minutes.
   - Total failure (503)      -> not cached.

   No Anthropic call in this route — the console is deterministic.
   ============================================================ */

// Space-Track auth uses cookies -> Node runtime required.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Mirror vercel.json maxDuration.
export const maxDuration = 30;

const ISS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — full success
const ISS_PARTIAL_CACHE_TTL_MS = 60 * 1000; // 1 minute — one source failed
// cdm_public cap; ISS rows are filtered out of this batch server-side.
// Shared with the console (lib/iss.ts) so the on-screen caveat matches.
const CDM_LIMIT = ISS_CDM_SCAN_LIMIT;

interface CacheEntry {
  data: IssStatus;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_KEY = "iss";

function getCached(): IssStatus | null {
  const entry = cache.get(CACHE_KEY);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(CACHE_KEY);
  return null;
}

function setCached(data: IssStatus, ttlMs: number): void {
  cache.set(CACHE_KEY, { data, expires: Date.now() + ttlMs });
}

/** Normalise any rejection reason to a short, safe string. */
function reasonMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "Unknown error";
}

/** Minimal shape guard — Space-Track rows are all-string objects. */
function isTleRow(v: unknown): v is SpaceTrackTLE {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.TLE_LINE1 === "string" && typeof o.TLE_LINE2 === "string";
}

function isCdmRow(v: unknown): v is SpaceTrackCDM {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.SAT_1_ID === "string" && typeof o.SAT_2_ID === "string";
}

export async function GET(): Promise<NextResponse> {
  const cached = getCached();
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    // ---- 1. Both sources concurrently; neither failure aborts the other ----
    const [tleResult, cdmResult] = await Promise.allSettled([
      searchTLE(ISS_NORAD_ID),
      fetchConjunctions(CDM_LIMIT),
    ]);

    const errors: IssStatus["errors"] = {};

    // ---- 2a. Element set ----
    let tle: SpaceTrackTLE | null = null;
    if (tleResult.status === "fulfilled") {
      if (isTleRow(tleResult.value)) {
        tle = tleResult.value;
      } else {
        errors.tle = `Space-Track returned no gp element set for NORAD ${ISS_NORAD_ID}.`;
      }
    } else {
      errors.tle = reasonMessage(tleResult.reason);
    }

    // ---- 2b. Public CDMs involving the ISS ----
    let cdms: SpaceTrackCDM[] = [];
    if (cdmResult.status === "fulfilled") {
      const rows = Array.isArray(cdmResult.value) ? cdmResult.value : [];
      cdms = rows.filter((row) => isCdmRow(row) && isIssCdm(row));
    } else {
      errors.cdms = reasonMessage(cdmResult.reason);
    }

    const tleFailed = tle === null;
    const cdmsFailed = typeof errors.cdms === "string";

    // ---- 3. Both failed -> 503, nothing useful to render ----
    if (tleFailed && cdmsFailed) {
      const detail = `TLE: ${errors.tle ?? "unavailable"} | CDM: ${errors.cdms ?? "unavailable"}`;
      console.error("[/api/iss] error:", detail);
      return NextResponse.json(
        { error: "ISS state unavailable from Space-Track.", detail },
        { status: 503 }
      );
    }

    const result: IssStatus = {
      tle,
      cdms,
      fetchedAt: new Date().toISOString(),
      errors,
    };

    if (tleFailed || cdmsFailed) {
      console.error(
        "[/api/iss] partial failure:",
        errors.tle ? `TLE: ${errors.tle}` : "",
        errors.cdms ? `CDM: ${errors.cdms}` : ""
      );
      setCached(result, ISS_PARTIAL_CACHE_TTL_MS);
    } else {
      setCached(result, ISS_CACHE_TTL_MS);
    }

    return NextResponse.json(result);
  } catch (err) {
    // allSettled never rejects; this guards anything unexpected
    // (e.g. a thrown error inside the filter / serialisation).
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/iss] error:", detail);
    return NextResponse.json(
      { error: "Failed to load ISS status.", detail },
      { status: 500 }
    );
  }
}
