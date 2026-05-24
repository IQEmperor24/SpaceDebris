import { NextResponse } from "next/server";
import { getAnthropic, CLAUDE_MODEL, DEFAULT_TEMPERATURE } from "@/lib/anthropic";
import {
  RISK_SYSTEM_PROMPT,
  buildRiskUserPrompt,
  type RiskScore,
} from "@/lib/prompts";
import { searchTLE, fetchTLEs, type SpaceTrackTLE } from "@/lib/spacetrack";

/* ============================================================
   POST /api/analyze   body: { query: string }

   Flow:
   1. searchTLE(query)            -> target object (404 if none)
   2. fetchTLEs(sample)           -> nearby-object context
   3. Claude (model + temp 0)     -> RiskScore JSON
   4. parse + return RiskScore + attached TLE

   The response is the parsed RiskScore SPREAD with `tle: target`
   attached. Downstream features (maneuver, fleet) reuse the TLE
   without a second Space-Track lookup. The existing RiskScorer UI
   ignores `.tle` so this change is non-breaking — Claude is still
   told to return only the 9 scored fields and that contract is
   unchanged.

   Model string + temperature come from lib/anthropic.ts.
   Prompts come from lib/prompts.ts (Workflow Rule #3).
   ============================================================ */

// Space-Track auth uses cookies -> Node runtime required.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Mirror vercel.json maxDuration so the Claude call has headroom.
export const maxDuration = 30;

const NEARBY_SAMPLE_SIZE = 300; // pulled from Space-Track for context
const NEARBY_ALT_WINDOW_KM = 100; // +/- altitude band considered "nearby"
const MAX_NEARBY = 15; // cap objects sent to Claude

/** Mean altitude (km) of an object from its apoapsis/periapsis. */
function meanAltitudeKm(o: SpaceTrackTLE): number {
  const apo = parseFloat(o.APOAPSIS);
  const peri = parseFloat(o.PERIAPSIS);
  if (!Number.isFinite(apo) || !Number.isFinite(peri)) return NaN;
  return (apo + peri) / 2;
}

/** Pick objects in a similar orbit to the target (by altitude band). */
function selectNearby(
  target: SpaceTrackTLE,
  sample: SpaceTrackTLE[]
): SpaceTrackTLE[] {
  const targetAlt = meanAltitudeKm(target);
  const others = sample.filter((o) => o.NORAD_CAT_ID !== target.NORAD_CAT_ID);

  if (Number.isFinite(targetAlt)) {
    const banded = others.filter((o) => {
      const alt = meanAltitudeKm(o);
      return (
        Number.isFinite(alt) && Math.abs(alt - targetAlt) <= NEARBY_ALT_WINDOW_KM
      );
    });
    if (banded.length > 0) return banded.slice(0, MAX_NEARBY);
  }

  // Fallback: always give Claude some context.
  return others.slice(0, MAX_NEARBY);
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

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // ---- 1. Validate input ----
    let body: { query?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON: { query: string }" },
        { status: 400 }
      );
    }

    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return NextResponse.json(
        { error: "Missing required field: query (satellite name or NORAD ID)." },
        { status: 400 }
      );
    }

    // ---- 2. Find the target object ----
    const target = await searchTLE(query);
    if (!target) {
      return NextResponse.json(
        { error: `No object found matching "${query}".` },
        { status: 404 }
      );
    }

    // ---- 3. Gather nearby-object context ----
    const sample = await fetchTLEs(NEARBY_SAMPLE_SIZE);
    const nearby = selectNearby(target, sample);

    // ---- 4. Claude risk score ----
    const client = getAnthropic();
    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      temperature: DEFAULT_TEMPERATURE,
      system: RISK_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildRiskUserPrompt(target, nearby) },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";

    let score: RiskScore;
    try {
      score = parseJsonObject(rawText) as RiskScore;
    } catch (parseErr) {
      const detail =
        parseErr instanceof Error ? parseErr.message : "Unknown parse error";
      console.error("[/api/analyze] JSON parse failed:", detail, "raw:", rawText);
      return NextResponse.json(
        { error: "AI returned an unparseable risk score.", detail },
        { status: 502 }
      );
    }

    // Attach the resolved TLE so downstream features (maneuver, fleet)
    // can reuse it without re-hitting Space-Track. Optional in the
    // RiskScore type — existing UI consumers ignore it.
    return NextResponse.json({ ...score, tle: target });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/analyze] error:", message);
    return NextResponse.json(
      { error: "Failed to analyze collision risk.", detail: message },
      { status: 500 }
    );
  }
}
