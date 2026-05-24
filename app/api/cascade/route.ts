import { NextResponse } from "next/server";
import { getAnthropic, CLAUDE_MODEL, DEFAULT_TEMPERATURE } from "@/lib/anthropic";
import {
  KESSLER_CASCADE_PROMPT,
  buildCascadeUserPrompt,
  type CascadeRequest,
  type CascadeSimulation,
  type CascadeStatus,
} from "@/lib/prompts";

/* ============================================================
   POST /api/cascade

   Body (JSON):
     {
       cdmId, sat1Name, sat1Id, sat2Name, sat2Id,
       tca, missDistanceKm, probability
     }

   Flow:
   1. Validate the conjunction event body.
   2. Check the 5-minute in-memory cache (keyed by full event identity).
   3. One Claude call -> 5-section plain-text cascade narrative.
   4. Regex-extract the trailing CASCADE STATUS line.
   5. Return { cdmId, text, status, generatedAt }.

   ---- Cache key — IMPORTANT ----
   Space-Track reuses CDM_ID across revisions of the same conjunction
   (each revision is a separate row in cdm_public with the same
   CDM_ID), so keying on cdmId alone caused different alert cards to
   collide on the same cache entry and render identical cascade text.

   We now key on a composite of the full event identity:
     cdmId | sat1Id | sat2Id | tca | missDistanceKm | probability
   This guarantees that two distinct conjunctions never share a slot,
   while two genuinely identical events (same pair, same TCA, same
   metrics) still get one Claude call and share the cached result.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CASCADE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CASCADE_MAX_TOKENS = 1500; // ~400-word output + status line + slack

interface CacheEntry {
  data: CascadeSimulation;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

/** Composite cache key — see header comment for rationale. */
function buildCacheKey(event: CascadeRequest): string {
  return [
    event.cdmId,
    event.sat1Id,
    event.sat2Id,
    event.tca,
    event.missDistanceKm,
    event.probability,
  ].join("|");
}

function getCached(key: string): CascadeSimulation | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCached(key: string, data: CascadeSimulation): void {
  cache.set(key, {
    data,
    expires: Date.now() + CASCADE_CACHE_TTL_MS,
  });
}

/**
 * Extract the cascade status from the model's trailing status line.
 * Tolerant of brackets, extra whitespace, and trailing punctuation.
 * Defaults to WARNING if the line is missing or unparseable — safer
 * than CONTAINED, which would understate the threat in the UI.
 */
function extractStatus(text: string): CascadeStatus {
  const match = text.match(
    /CASCADE\s*STATUS\s*:\s*\[?\s*(CONTAINED|WARNING|CRITICAL|CATASTROPHIC)/i
  );
  if (!match) return "WARNING";
  return match[1].toUpperCase() as CascadeStatus;
}

/** Best-effort validation of the POST body. */
function validateBody(body: unknown): CascadeRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const required = [
    "cdmId",
    "sat1Name",
    "sat1Id",
    "sat2Name",
    "sat2Id",
    "tca",
    "missDistanceKm",
    "probability",
  ] as const;
  for (const key of required) {
    if (typeof b[key] !== "string" || (b[key] as string).length === 0) {
      return null;
    }
  }
  return {
    cdmId: b.cdmId as string,
    sat1Name: b.sat1Name as string,
    sat1Id: b.sat1Id as string,
    sat2Name: b.sat2Name as string,
    sat2Id: b.sat2Id as string,
    tca: b.tca as string,
    missDistanceKm: b.missDistanceKm as string,
    probability: b.probability as string,
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
          "Missing or invalid fields. Required: cdmId, sat1Name, sat1Id, sat2Name, sat2Id, tca, missDistanceKm, probability (all strings).",
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
      max_tokens: CASCADE_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      system: KESSLER_CASCADE_PROMPT,
      messages: [
        { role: "user", content: buildCascadeUserPrompt(event) },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const rawText =
      textBlock && textBlock.type === "text" ? textBlock.text : "";

    if (!rawText.trim()) {
      throw new Error("Empty model response.");
    }

    const result: CascadeSimulation = {
      cdmId: event.cdmId,
      text: rawText.trim(),
      status: extractStatus(rawText),
      generatedAt: new Date().toISOString(),
    };

    setCached(cacheKey, result);
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/cascade] error:", detail);
    return NextResponse.json(
      { error: "Failed to simulate cascade.", detail },
      { status: 500 }
    );
  }
}
