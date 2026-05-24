import { NextResponse } from "next/server";
import { getAnthropic, CLAUDE_MODEL, DEFAULT_TEMPERATURE } from "@/lib/anthropic";
import {
  FLEET_INTELLIGENCE_PROMPT,
  buildFleetUserPrompt,
  type FleetAIAnalysis,
  type FleetIntelligence,
  type FleetStatsForPrompt,
  type FleetTopThreat,
  type RiskTrend,
  type ShellStatus,
  type ThreatLevel,
} from "@/lib/prompts";
import {
  fetchTLEs,
  fetchConjunctions,
  type SpaceTrackTLE,
  type SpaceTrackCDM,
} from "@/lib/spacetrack";

/* ============================================================
   GET /api/fleet

   Bloomberg-Terminal-for-space aggregate intelligence brief.

   Flow:
   1. Pull TLEs + CDMs from Space-Track (already cached by the
      spacetrack lib; concurrent fetch).
   2. Compute deterministic stats server-side:
        - total objects, shell counts (LEO/MEO/GEO bucketing)
        - HIGH/CRITICAL counts via industry PC + miss thresholds
        - top 3 threats by composite severity score
   3. ONE Claude call -> JSON: shell statuses, risk trend,
      executive brief, top-3 threat reasonings, 3 actions.
   4. Merge facts + interpretation -> FleetIntelligence.

   2-minute in-memory cache (single key) keeps token use low
   and matches the FleetDashboard's 120s client poll.

   ---- Why heuristic severity, not the conjunctions AI? ----
   The /api/conjunctions route runs Claude per-event for the
   AlertFeed panel (cached 60s). Calling it from here would
   double up that classification AND tie aggregate counts to a
   per-event AI loop that varies with model output. Heuristic
   PC/miss thresholds are deterministic, instant, and match
   industry safe-pass criteria.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FLEET_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const DEBRIS_SAMPLE = 2000; // matches OrbitalMap DEBRIS_LIMIT
const CDM_LIMIT = 25; // pull more than the AlertFeed shows so the top-3 ranking has signal
const TOP_THREAT_COUNT = 3;
const RECOMMENDED_ACTION_COUNT = 3;
const FLEET_MAX_TOKENS = 2048;

interface CacheEntry {
  data: FleetIntelligence;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_KEY = "fleet";

function getCached(): FleetIntelligence | null {
  const entry = cache.get(CACHE_KEY);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(CACHE_KEY);
  return null;
}

function setCached(data: FleetIntelligence): void {
  cache.set(CACHE_KEY, {
    data,
    expires: Date.now() + FLEET_CACHE_TTL_MS,
  });
}

/** Composite severity score — higher = worse. Used to rank top CDMs. */
function cdmSeverityScore(c: SpaceTrackCDM): number {
  const miss = parseFloat(c.MIN_RNG);
  const pc = parseFloat(c.PC);
  const missTerm =
    Number.isFinite(miss) && miss > 0 ? 10 / miss : 0; // closer = bigger score
  const pcTerm = Number.isFinite(pc) ? pc * 1000 : 0;
  return missTerm + pcTerm;
}

/**
 * Industry-standard heuristic threat class for a single CDM.
 * - CRITICAL: PC >= 1e-3 OR miss < 0.1 km  (red-line, immediate action)
 * - HIGH:     PC >= 1e-4 OR miss < 1 km    (above SpaceX's 3e-7 maneuver threshold)
 * - MEDIUM:   PC >= 1e-5 OR miss < 5 km
 * - LOW:      everything else
 */
function classifyCDM(c: SpaceTrackCDM): ThreatLevel {
  const miss = parseFloat(c.MIN_RNG);
  const pc = parseFloat(c.PC);
  const missValid = Number.isFinite(miss);
  const pcValid = Number.isFinite(pc);
  if ((pcValid && pc >= 1e-3) || (missValid && miss < 0.1)) return "CRITICAL";
  if ((pcValid && pc >= 1e-4) || (missValid && miss < 1)) return "HIGH";
  if ((pcValid && pc >= 1e-5) || (missValid && miss < 5)) return "MEDIUM";
  return "LOW";
}

/** Mean altitude (km) of an object from its apoapsis/periapsis. */
function meanAltitudeKm(o: SpaceTrackTLE): number {
  const apo = parseFloat(o.APOAPSIS);
  const peri = parseFloat(o.PERIAPSIS);
  if (!Number.isFinite(apo) || !Number.isFinite(peri)) return NaN;
  return (apo + peri) / 2;
}

/** Bucket objects into LEO / MEO / GEO by mean altitude. */
function bucketByShell(
  tles: SpaceTrackTLE[]
): { leo: number; meo: number; geo: number } {
  let leo = 0;
  let meo = 0;
  let geo = 0;
  for (const t of tles) {
    const alt = meanAltitudeKm(t);
    if (!Number.isFinite(alt)) continue;
    if (alt < 2000) leo++;
    else if (alt < 35000) meo++;
    else geo++;
  }
  return { leo, meo, geo };
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

const VALID_SHELL_STATUSES: ReadonlySet<ShellStatus> = new Set<ShellStatus>([
  "NOMINAL",
  "ELEVATED",
  "CRITICAL",
]);
const VALID_TRENDS: ReadonlySet<RiskTrend> = new Set<RiskTrend>([
  "IMPROVING",
  "STABLE",
  "DETERIORATING",
]);
const VALID_THREATS: ReadonlySet<ThreatLevel> = new Set<ThreatLevel>([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

function safeShell(v: unknown): ShellStatus {
  return typeof v === "string" && VALID_SHELL_STATUSES.has(v as ShellStatus)
    ? (v as ShellStatus)
    : "NOMINAL";
}
function safeTrend(v: unknown): RiskTrend {
  return typeof v === "string" && VALID_TRENDS.has(v as RiskTrend)
    ? (v as RiskTrend)
    : "STABLE";
}
function safeThreat(v: unknown): ThreatLevel {
  return typeof v === "string" && VALID_THREATS.has(v as ThreatLevel)
    ? (v as ThreatLevel)
    : "MEDIUM";
}

/** Sanitize Claude's topThreats array into trusted, capped objects. */
function safeTopThreats(v: unknown): FleetTopThreat[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, TOP_THREAT_COUNT)
    .map((t) => {
      const obj = (t && typeof t === "object" ? t : {}) as Record<
        string,
        unknown
      >;
      return {
        name: typeof obj.name === "string" ? obj.name : "Unknown pair",
        reasoning:
          typeof obj.reasoning === "string"
            ? obj.reasoning
            : "No reasoning provided.",
        severity: safeThreat(obj.severity),
      };
    });
}

function safeRecommendedActions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((a): a is string => typeof a === "string" && a.length > 0)
    .slice(0, RECOMMENDED_ACTION_COUNT);
}

export async function GET(): Promise<NextResponse> {
  const cached = getCached();
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    // ---- 1. Pull both data sources concurrently ----
    const [tles, cdms] = await Promise.all([
      fetchTLEs(DEBRIS_SAMPLE),
      fetchConjunctions(CDM_LIMIT),
    ]);

    // ---- 2. Aggregate deterministic stats ----
    const totalObjects = tles.length;
    const shellCounts = bucketByShell(tles);

    const sortedCDMs = [...cdms].sort(
      (a, b) => cdmSeverityScore(b) - cdmSeverityScore(a)
    );

    let highPriorityCount = 0;
    let criticalCount = 0;
    for (const c of cdms) {
      const cls = classifyCDM(c);
      if (cls === "CRITICAL") criticalCount++;
      else if (cls === "HIGH") highPriorityCount++;
    }

    const topCDMs = sortedCDMs.slice(0, TOP_THREAT_COUNT);

    // ---- 3. Build Claude prompt input ----
    const stats: FleetStatsForPrompt = {
      totalObjects,
      activeConjunctions: cdms.length,
      highPriorityCount,
      criticalCount,
      shellCounts,
      topCDMs: topCDMs.map((c) => ({
        pair: `${c.SAT_1_NAME} ↔ ${c.SAT_2_NAME}`,
        tca: c.TCA,
        missKm: c.MIN_RNG,
        pc: c.PC,
      })),
    };

    // ---- 4. Claude intelligence brief ----
    const client = getAnthropic();
    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: FLEET_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      system: FLEET_INTELLIGENCE_PROMPT,
      messages: [{ role: "user", content: buildFleetUserPrompt(stats) }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const rawText =
      textBlock && textBlock.type === "text" ? textBlock.text : "";

    let ai: FleetAIAnalysis;
    try {
      const parsed = parseJsonObject(rawText) as Partial<FleetAIAnalysis> & {
        shells?: Partial<FleetAIAnalysis["shells"]>;
      };
      ai = {
        shells: {
          leo: safeShell(parsed.shells?.leo),
          meo: safeShell(parsed.shells?.meo),
          geo: safeShell(parsed.shells?.geo),
        },
        executiveBrief:
          typeof parsed.executiveBrief === "string"
            ? parsed.executiveBrief
            : "Brief unavailable.",
        riskTrend: safeTrend(parsed.riskTrend),
        topThreats: safeTopThreats(parsed.topThreats),
        recommendedActions: safeRecommendedActions(parsed.recommendedActions),
      };
    } catch (parseErr) {
      const detail =
        parseErr instanceof Error ? parseErr.message : "Unknown parse error";
      console.error(
        "[/api/fleet] JSON parse failed:",
        detail,
        "raw:",
        rawText
      );
      return NextResponse.json(
        { error: "AI returned an unparseable fleet brief.", detail },
        { status: 502 }
      );
    }

    // ---- 5. Merge facts + interpretation ----
    const result: FleetIntelligence = {
      generatedAt: new Date().toISOString(),
      totalObjects,
      activeConjunctions: cdms.length,
      highPriorityCount,
      criticalCount,
      shells: {
        leo: { count: shellCounts.leo, status: ai.shells.leo },
        meo: { count: shellCounts.meo, status: ai.shells.meo },
        geo: { count: shellCounts.geo, status: ai.shells.geo },
      },
      executiveBrief: ai.executiveBrief,
      riskTrend: ai.riskTrend,
      topThreats: ai.topThreats,
      recommendedActions: ai.recommendedActions,
    };

    setCached(result);
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/fleet] error:", detail);
    return NextResponse.json(
      { error: "Failed to generate fleet intelligence.", detail },
      { status: 500 }
    );
  }
}
