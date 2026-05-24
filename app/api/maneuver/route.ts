import { NextResponse } from "next/server";
import { getAnthropic, CLAUDE_MODEL, DEFAULT_TEMPERATURE } from "@/lib/anthropic";
import {
  MANEUVER_RECOMMENDATION_PROMPT,
  buildManeuverUserPrompt,
  type ManeuverLevel,
  type ManeuverPlan,
  type ManeuverRequest,
  type ThreatLevel,
} from "@/lib/prompts";

/* ============================================================
   POST /api/maneuver

   Body (JSON, ManeuverRequest):
     {
       satelliteName, noradId,
       altitudeKm, periodMinutes, inclinationDeg,
       collisionProbability, debrisDensity, orbitalStability,
       overallThreat, closestApproach,
       tleLine1?, tleLine2?            // optional raw TLE
     }

   Flow:
   1. Validate body.
   2. Check the 2-minute in-memory cache (keyed on the full
      satellite-identity + threat-picture tuple).
   3. One Claude call -> 6-section plain-text maneuver plan.
   4. Regex-extract the trailing RECOMMENDATION line.
   5. Return { satelliteName, text, recommendation, generatedAt }.

   ---- Cache key ----
   A maneuver plan depends on satellite identity AND the threat
   picture. Different overallThreat or materially different
   collisionProbability => different plan, so they're folded into
   the key. The same satellite reassessed at the same threat level
   shares the cached plan, which keeps demos snappy and avoids
   re-burning tokens on a re-click.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MANEUVER_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MANEUVER_MAX_TOKENS = 1500; // ~350-word output + RECOMMENDATION + slack

interface CacheEntry {
  data: ManeuverPlan;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

const VALID_THREATS: ReadonlySet<ThreatLevel> = new Set<ThreatLevel>([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

/** Composite cache key — see header comment for rationale. */
function buildCacheKey(req: ManeuverRequest): string {
  return [
    req.satelliteName,
    req.noradId,
    req.overallThreat,
    req.collisionProbability,
  ].join("|");
}

function getCached(key: string): ManeuverPlan | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCached(key: string, data: ManeuverPlan): void {
  cache.set(key, {
    data,
    expires: Date.now() + MANEUVER_CACHE_TTL_MS,
  });
}

/**
 * Extract the action recommendation from the model's trailing line.
 * Tolerant of brackets and extra whitespace. Defaults to PREPARE if
 * missing — middle of the road, never understates or overstates.
 */
function extractRecommendation(text: string): ManeuverLevel {
  const match = text.match(
    /RECOMMENDATION\s*:\s*\[?\s*(MONITOR|PREPARE|EXECUTE|EMERGENCY)/i
  );
  if (!match) return "PREPARE";
  return match[1].toUpperCase() as ManeuverLevel;
}

/** Best-effort validation of the POST body. */
function validateBody(body: unknown): ManeuverRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const stringFields: ReadonlyArray<keyof ManeuverRequest> = [
    "satelliteName",
    "noradId",
    "overallThreat",
    "closestApproach",
  ];
  for (const key of stringFields) {
    const v = b[key as string];
    if (typeof v !== "string" || v.length === 0) return null;
  }

  const numberFields: ReadonlyArray<keyof ManeuverRequest> = [
    "altitudeKm",
    "periodMinutes",
    "inclinationDeg",
    "collisionProbability",
    "debrisDensity",
    "orbitalStability",
  ];
  for (const key of numberFields) {
    const v = b[key as string];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }

  if (!VALID_THREATS.has(b.overallThreat as ThreatLevel)) return null;

  return {
    satelliteName: b.satelliteName as string,
    noradId: b.noradId as string,
    altitudeKm: b.altitudeKm as number,
    periodMinutes: b.periodMinutes as number,
    inclinationDeg: b.inclinationDeg as number,
    collisionProbability: b.collisionProbability as number,
    debrisDensity: b.debrisDensity as number,
    orbitalStability: b.orbitalStability as number,
    overallThreat: b.overallThreat as ThreatLevel,
    closestApproach: b.closestApproach as string,
    tleLine1: typeof b.tleLine1 === "string" ? b.tleLine1 : undefined,
    tleLine2: typeof b.tleLine2 === "string" ? b.tleLine2 : undefined,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const event = validateBody(rawBody);
  if (!event) {
    return NextResponse.json(
      {
        error:
          "Missing or invalid fields. Required strings: satelliteName, noradId, overallThreat (LOW|MEDIUM|HIGH|CRITICAL), closestApproach. Required numbers: altitudeKm, periodMinutes, inclinationDeg, collisionProbability, debrisDensity, orbitalStability. Optional: tleLine1, tleLine2.",
      },
      { status: 400 }
    );
  }

  const cacheKey = buildCacheKey(event);

  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MANEUVER_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      system: MANEUVER_RECOMMENDATION_PROMPT,
      messages: [
        { role: "user", content: buildManeuverUserPrompt(event) },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const rawText =
      textBlock && textBlock.type === "text" ? textBlock.text : "";

    if (!rawText.trim()) {
      throw new Error("Empty model response.");
    }

    const result: ManeuverPlan = {
      satelliteName: event.satelliteName,
      text: rawText.trim(),
      recommendation: extractRecommendation(rawText),
      generatedAt: new Date().toISOString(),
    };

    setCached(cacheKey, result);
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/maneuver] error:", detail);
    return NextResponse.json(
      { error: "Failed to generate maneuver plan.", detail },
      { status: 500 }
    );
  }
}
