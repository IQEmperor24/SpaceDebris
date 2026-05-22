import { NextResponse } from "next/server";
import {
  fetchTLEs,
  searchTLE,
  type SpaceTrackTLE,
} from "@/lib/spacetrack";

/* ============================================================
   GET /api/debris

   Two modes (CONTEXT.md API Route Summary):
   - ?limit=500   -> bulk TLE sample for the 3D orbital map
   - ?search=ISS  -> single object lookup for the risk scorer

   10-minute in-memory cache (Gotcha #9) to respect the
   Space-Track rate limit (30/min, 300/hr).

   NOTE: in-memory cache is per serverless instance — fine for
   the demo; the documented upgrade path is MongoDB/Snowflake.
   ============================================================ */

// Must run on Node.js: Space-Track auth relies on cookies.
export const runtime = "nodejs";
// Never statically optimize — our own cache controls freshness.
export const dynamic = "force-dynamic";

const DEBRIS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_LIMIT = 500;

interface CacheEntry {
  data: unknown;
  expires: number;
}

// Module-scoped cache (survives across requests on a warm instance).
const cache = new Map<string, CacheEntry>();

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) {
    return entry.data;
  }
  if (entry) cache.delete(key); // expired — drop it
  return null;
}

function setCached(key: string, data: unknown): void {
  cache.set(key, { data, expires: Date.now() + DEBRIS_CACHE_TTL_MS });
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search");

  try {
    // ---- Mode 1: search by name or NORAD ID (risk scorer) ----
    if (search && search.trim()) {
      const key = `search:${search.trim().toLowerCase()}`;
      const cached = getCached(key);
      if (cached) {
        return NextResponse.json(cached);
      }

      const object = await searchTLE(search);
      const payload: { object: SpaceTrackTLE | null } = { object };
      setCached(key, payload);
      return NextResponse.json(payload);
    }

    // ---- Mode 2: bulk TLE sample (orbital map) ----
    const limitParam = searchParams.get("limit");
    const parsed = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;

    const key = `list:${limit}`;
    const cached = getCached(key);
    if (cached) {
      return NextResponse.json(cached);
    }

    const objects = await fetchTLEs(limit);
    const payload: { count: number; objects: SpaceTrackTLE[] } = {
      count: objects.length,
      objects,
    };
    setCached(key, payload);
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/debris] error:", message);
    return NextResponse.json(
      { error: "Failed to fetch debris data from Space-Track.", detail: message },
      { status: 500 }
    );
  }
}
