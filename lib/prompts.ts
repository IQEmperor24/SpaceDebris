/* ============================================================
   SpaceDebris — ALL Claude prompts + shared types

   *** Workflow Rule #3: every Claude prompt lives HERE. ***
   API routes import these builders/constants — they must
   NEVER inline a prompt string.

   This file is pure prompt text + TypeScript contracts. The
   model string and temperature live in lib/anthropic.ts.
   ============================================================ */

import type { SpaceTrackTLE, SpaceTrackCDM } from "@/lib/spacetrack";

/* ------------------------------------------------------------
   Shared contracts (Workflow Rule #10 — explicit types).
   ------------------------------------------------------------ */

export type ThreatLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Output of POST /api/analyze.
 * Matches CONTEXT.md "Example Risk Score Output Format" exactly.
 */
export interface RiskScore {
  collisionProbability: number; // 0-100
  debrisDensity: number; // 0-100
  orbitalStability: number; // 0-100
  overallThreat: ThreatLevel;
  closestApproach: string; // e.g. "2.3km in 4.2 hours"
  recommendation: string; // plain-English avoidance maneuver
  summary: string; // plain-English situation summary
  altitudeKm: number;
  periodMinutes: number;
  inclinationDeg: number;
}

/** One AI-summarized conjunction alert for Panel 3. */
export interface ConjunctionSummary {
  cdmId: string; // echoes SpaceTrackCDM.CDM_ID for mapping
  plainEnglish: string; // human-readable threat description
  recommendation: string; // AI-suggested action
  urgency: ThreatLevel;
}

/** Wrapper Claude returns for the conjunctions feed. */
export interface ConjunctionSummaryResponse {
  alerts: ConjunctionSummary[];
}

/**
 * Merged shape returned by GET /api/conjunctions and consumed by
 * the AlertFeed component: factual CDM fields + AI summary fields.
 */
export interface ConjunctionAlert {
  cdmId: string;
  sat1Name: string;
  sat1Id: string;
  sat2Name: string;
  sat2Id: string;
  tca: string; // time of closest approach
  missDistanceKm: string;
  probability: string;
  plainEnglish: string;
  recommendation: string;
  urgency: ThreatLevel;
}

/* ------------------------------------------------------------
   1) Risk scoring (POST /api/analyze)
   ------------------------------------------------------------ */

export const RISK_SYSTEM_PROMPT = `You are an expert orbital mechanics analyst and space debris collision-risk assessor working for a satellite operations center. You interpret raw TLE (Two-Line Element) data and the surrounding debris environment to score collision risk and recommend concrete avoidance maneuvers.

You reason quantitatively about altitude, inclination, orbital period, eccentricity, and the density of nearby objects. You are precise, calm, and decisive — operators act on your output.

You ALWAYS respond with a single valid JSON object and NOTHING else. No markdown, no code fences, no commentary before or after.

The JSON object MUST match this exact schema:
{
  "collisionProbability": <integer 0-100>,
  "debrisDensity": <integer 0-100>,
  "orbitalStability": <integer 0-100>,
  "overallThreat": <"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">,
  "closestApproach": <string, e.g. "2.3km in 4.2 hours">,
  "recommendation": <string, plain-English avoidance maneuver>,
  "summary": <string, 1-3 sentence plain-English situation summary>,
  "altitudeKm": <number>,
  "periodMinutes": <number>,
  "inclinationDeg": <number>
}

Rules:
- For altitudeKm, periodMinutes, and inclinationDeg, use the orbital data provided in the user message; do not invent values.
- Scores are integers 0-100 where higher means greater risk/density and (for stability) higher means MORE stable.
- overallThreat must be consistent with the scores.
- Return ONLY the JSON object.`;

/**
 * Build the risk-scoring user prompt from a target object and its
 * nearby objects (both already fetched from Space-Track).
 */
export function buildRiskUserPrompt(
  target: SpaceTrackTLE,
  nearby: SpaceTrackTLE[]
): string {
  const targetBlock = [
    `TARGET OBJECT`,
    `Name: ${target.OBJECT_NAME}`,
    `NORAD ID: ${target.NORAD_CAT_ID}`,
    `TLE Line 1: ${target.TLE_LINE1}`,
    `TLE Line 2: ${target.TLE_LINE2}`,
    `Inclination (deg): ${target.INCLINATION}`,
    `Eccentricity: ${target.ECCENTRICITY}`,
    `Mean motion (rev/day): ${target.MEAN_MOTION}`,
    `Orbital period (min): ${target.PERIOD}`,
    `Apoapsis altitude (km): ${target.APOAPSIS}`,
    `Periapsis altitude (km): ${target.PERIAPSIS}`,
  ].join("\n");

  const nearbyBlock =
    nearby.length > 0
      ? nearby
          .map(
            (o, i) =>
              `${i + 1}. ${o.OBJECT_NAME} (NORAD ${o.NORAD_CAT_ID}) — incl ${o.INCLINATION}°, period ${o.PERIOD} min, apo ${o.APOAPSIS} km / peri ${o.PERIAPSIS} km`
          )
          .join("\n")
      : "No nearby-object data available.";

  return `Assess the collision risk for the following object using its TLE data and the surrounding debris environment.

${targetBlock}

NEARBY OBJECTS (${nearby.length}):
${nearbyBlock}

Return ONLY the JSON risk-score object described in your instructions.`;
}

/* ------------------------------------------------------------
   2) Conjunction feed summaries (GET /api/conjunctions)
   ------------------------------------------------------------ */

export const CONJUNCTION_SYSTEM_PROMPT = `You are a space situational-awareness analyst summarizing conjunction events (close approaches between two orbiting objects) for a live operations dashboard. Each event comes from a CDM (Conjunction Data Message).

For each event you write a short, plain-English description a non-expert can understand, suggest a concrete recommended action, and assign an urgency level. Base urgency on the miss distance (MIN_RNG, km), probability of collision (PC), and how soon the time of closest approach (TCA) is.

You ALWAYS respond with a single valid JSON object and NOTHING else — no markdown, no code fences, no commentary.

The JSON object MUST match this exact schema:
{
  "alerts": [
    {
      "cdmId": <string, copied exactly from the input>,
      "plainEnglish": <string, 1-2 sentence description>,
      "recommendation": <string, suggested action>,
      "urgency": <"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">
    }
  ]
}

Rules:
- Return one alert object per input event, in the same order.
- Copy each cdmId EXACTLY from the input so it can be matched back.
- Return ONLY the JSON object.`;

/**
 * Build the conjunctions user prompt. All CDMs are sent in ONE call
 * (batched) to stay fast and within Space-Track/Anthropic limits;
 * Claude returns one alert per event, echoing each cdmId.
 */
export function buildConjunctionsUserPrompt(cdms: SpaceTrackCDM[]): string {
  const eventsBlock = cdms
    .map(
      (c, i) =>
        `Event ${i + 1}:
  cdmId: ${c.CDM_ID}
  Object 1: ${c.SAT_1_NAME} (NORAD ${c.SAT_1_ID})
  Object 2: ${c.SAT_2_NAME} (NORAD ${c.SAT_2_ID})
  Time of closest approach (TCA): ${c.TCA}
  Miss distance (km): ${c.MIN_RNG}
  Probability of collision: ${c.PC}`
    )
    .join("\n\n");

  return `Summarize the following ${cdms.length} conjunction event(s) for the live alert feed.

${eventsBlock}

Return ONLY the JSON object with an "alerts" array, one entry per event, each echoing its cdmId exactly.`;
}
