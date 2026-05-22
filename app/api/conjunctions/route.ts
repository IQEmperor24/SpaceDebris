import { NextResponse } from "next/server";
import { getAnthropic, CLAUDE_MODEL, DEFAULT_TEMPERATURE } from "@/lib/anthropic";
import {
  CONJUNCTION_SYSTEM_PROMPT,
  buildConjunctionsUserPrompt,
  type ConjunctionSummary,
  type ConjunctionSummaryResponse,
  type ConjunctionAlert,
} from "@/lib/prompts";
import { fetchConjunctions, type SpaceTrackCDM } from "@/lib/spacetrack";

/* ============================================================
   GET /api/conjunctions

   Flow:
   1. fetchConjunctions()  -> real CDM close-approach events
   2. ONE batched Claude call -> plain-English summaries
   3. merge AI summary (by cdmId) with factual CDM fields
   4. return alerts, soonest TCA first

   60-second in-memory cache (Gotcha #9) — matches the Panel 3
   auto-refresh cadence and respects Space-Track rate limits.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CONJUNCTION_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const CONJUNCTION_LIMIT = 10; // events shown in the feed

interface CacheEntry {
  data: unknown;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_KEY = "conjunctions";

function getCached(): unknown | null {
  const entry = cache.get(CACHE_KEY);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(CACHE_KEY);
  return null;
}

function setCached(data: unknown): void {
  cache.set(CACHE_KEY, {
    data,
    expires: Date.now() + CONJUNCTION_CACHE_TTL_MS,
  });
}

/** Extract the first JSON object from a model response (Gotcha #6). */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model response.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

/** Ask Claude to summarize all CDMs in one call; map by cdmId. */
async function summarize(
  cdms: SpaceTrackCDM[]
): Promise<Map<string, ConjunctionSummary>> {
  const client = getAnthropic();
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    temperature: DEFAULT_TEMPERATURE,
    system: CONJUNCTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildConjunctionsUserPrompt(cdms) }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  const rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";

  const parsed = parseJsonObject(rawText) as ConjunctionSummaryResponse;
  const byId = new Map<string, ConjunctionSummary>();
  for (const alert of parsed.alerts ?? []) {
    byId.set(alert.cdmId, alert);
  }
  return byId;
}

export async function GET(): Promise<NextResponse> {
  const cached = getCached();
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const cdms = await fetchConjunctions(CONJUNCTION_LIMIT);

    // No conjunctions -> skip the Claude call entirely.
    if (cdms.length === 0) {
      const payload = { count: 0, alerts: [] as ConjunctionAlert[] };
      setCached(payload);
      return NextResponse.json(payload);
    }

    // One batched AI call for all events.
    const summaries = await summarize(cdms);

    // Merge AI summary with factual CDM fields, preserving TCA order.
    const alerts: ConjunctionAlert[] = cdms.map((c) => {
      const ai = summaries.get(c.CDM_ID);
      return {
        cdmId: c.CDM_ID,
        sat1Name: c.SAT_1_NAME,
        sat1Id: c.SAT_1_ID,
        sat2Name: c.SAT_2_NAME,
        sat2Id: c.SAT_2_ID,
        tca: c.TCA,
        missDistanceKm: c.MIN_RNG,
        probability: c.PC,
        plainEnglish:
          ai?.plainEnglish ??
          `Close approach between ${c.SAT_1_NAME} and ${c.SAT_2_NAME}.`,
        recommendation: ai?.recommendation ?? "Monitor — awaiting AI assessment.",
        urgency: ai?.urgency ?? "LOW",
      };
    });

    const payload = { count: alerts.length, alerts };
    setCached(payload);
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/conjunctions] error:", message);
    return NextResponse.json(
      { error: "Failed to fetch conjunction alerts.", detail: message },
      { status: 500 }
    );
  }
}
