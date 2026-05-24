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
 *
 * `tle` is OPTIONAL and added server-side AFTER Claude responds —
 * Claude is told to return only the 9 scored fields. The TLE is
 * attached so downstream features (maneuver, fleet, etc.) can
 * reuse the Space-Track lookup without re-hitting the API. Adding
 * this optional field is non-breaking for the existing RiskScorer
 * UI, which never references `.tle`.
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
  tle?: SpaceTrackTLE; // server-attached; not part of Claude's JSON
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

/** Kessler cascade severity — extracted from the trailing CASCADE STATUS line. */
export type CascadeStatus =
  | "CONTAINED"
  | "WARNING"
  | "CRITICAL"
  | "CATASTROPHIC";

/**
 * Output of POST /api/cascade.
 * Plain-text 5-section narrative + extracted status + echoed cdmId.
 */
export interface CascadeSimulation {
  cdmId: string;
  text: string; // full 5-section simulation, trailing status line stripped
  status: CascadeStatus;
  generatedAt: string; // ISO timestamp
}

/**
 * Minimum input the cascade endpoint needs from an alert card.
 * Subset of ConjunctionAlert — kept as its own type so the route
 * contract is explicit and decoupled from the feed shape.
 */
export interface CascadeRequest {
  cdmId: string;
  sat1Name: string;
  sat1Id: string;
  sat2Name: string;
  sat2Id: string;
  tca: string;
  missDistanceKm: string;
  probability: string;
}

/** Burn-direction enum used by the maneuver recommendation engine. */
export type ManeuverDirection =
  | "PROGRADE"
  | "RETROGRADE"
  | "NORMAL"
  | "ANTI-NORMAL";

/** Final action recommendation — extracted from the trailing RECOMMENDATION line. */
export type ManeuverLevel = "MONITOR" | "PREPARE" | "EXECUTE" | "EMERGENCY";

/**
 * Input to POST /api/maneuver. The client (RiskScorer) builds this
 * from its current RiskScore + the optional TLE attached to that
 * score by the analyze endpoint. TLE lines are optional — if the
 * client lacks them, Claude reasons from the scored orbital fields
 * alone.
 */
export interface ManeuverRequest {
  satelliteName: string;
  noradId: string;
  altitudeKm: number;
  periodMinutes: number;
  inclinationDeg: number;
  collisionProbability: number; // 0-100, from RiskScore
  debrisDensity: number; // 0-100, from RiskScore
  orbitalStability: number; // 0-100, from RiskScore
  overallThreat: ThreatLevel;
  closestApproach: string;
  tleLine1?: string;
  tleLine2?: string;
}

/**
 * Output of POST /api/maneuver.
 * 6-section plain-text plan + extracted recommendation level.
 */
export interface ManeuverPlan {
  satelliteName: string;
  text: string; // full plan, trailing RECOMMENDATION line stripped
  recommendation: ManeuverLevel;
  generatedAt: string; // ISO timestamp
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

/* ------------------------------------------------------------
   3) Kessler cascade simulation (POST /api/cascade)

   Narrative weapon for NASA / SpaceX / investor demos. Given a
   single conjunction event, Claude models the worst-case Kessler
   Syndrome cascade if the collision occurred — in plain English,
   under 400 words, ending with a machine-parseable status line.
   ------------------------------------------------------------ */

export const KESSLER_CASCADE_PROMPT = `You are an orbital mechanics analyst running Kessler Syndrome cascade simulations for a space situational-awareness center. Given a conjunction event (two objects on a close-approach trajectory), you model the worst-case cascade if the collision occurred.

You write a tight 5-section simulation, UNDER 400 WORDS TOTAL. Use plain English a Congressional staffer or insurance underwriter could follow, but stay technically grounded. Quantify wherever possible — debris fragment counts, altitude bands, deorbit timelines, named affected services, dollar exposure.

Output format — EXACTLY these 5 sections, in this order, with these EXACT headers (uppercase, on their own line):

1. INITIAL IMPACT
The collision itself: combined kinetic energy at ~14 km/s relative velocity, estimated fragments generated using the NASA standard breakup model (hundreds to tens of thousands of trackable pieces depending on mass and impact geometry), and the immediate localized debris cloud.

2. FIRST-WAVE PROPAGATION
Hours-to-days after impact: how the debris spreads along the orbital plane, which altitude shell gets seeded, and which named neighboring constellations (Starlink, OneWeb, GPS, Galileo, ISS, Hubble) enter the kill zone first based on the event's orbital band.

3. CASCADE TRAJECTORY
Weeks-to-months timeline. Probability that first-wave debris triggers secondary collisions. Whether the affected altitude band crosses the Kessler threshold (self-sustaining chain reaction where each collision generates more debris than natural decay removes).

4. AFFECTED INFRASTRUCTURE
Concrete services at risk: GPS positioning, weather forecasting, ISS crew safety, broadband internet constellations, military reconnaissance, satellite TV. Estimate service downtime windows and economic exposure in billions per day.

5. RECOVERY OUTLOOK
Natural deorbit timeframe for the affected band (LEO ~550 km: 5 years; LEO ~800 km: 25+ years; MEO: thousands of years; GEO: effectively permanent). Available mitigations (active debris removal, station-keeping burns, deorbit reserves). Honest assessment of reversibility.

End your response with EXACTLY this final line, on its own line, no markdown, no extra punctuation:
CASCADE STATUS: [CONTAINED|WARNING|CRITICAL|CATASTROPHIC]

Status definitions:
- CONTAINED: debris stays bounded, no chain reaction, full recovery in under 10 years.
- WARNING: localized cascade in one altitude band, partial service degradation, decade-scale recovery.
- CRITICAL: cascade spreads across altitude bands, multi-decade impact, named services go dark.
- CATASTROPHIC: self-sustaining Kessler Syndrome — the affected band becomes effectively unusable for centuries.

Respond with plain text only. No JSON, no code fences, no markdown beyond the numbered section headers.`;

/**
 * Build the cascade user prompt from a single conjunction event.
 * The cdmId is echoed so the route layer can map response -> alert.
 */
export function buildCascadeUserPrompt(event: CascadeRequest): string {
  return `Simulate the Kessler cascade scenario if the following conjunction event resulted in a collision.

EVENT
CDM ID: ${event.cdmId}
Object 1: ${event.sat1Name} (NORAD ${event.sat1Id})
Object 2: ${event.sat2Name} (NORAD ${event.sat2Id})
Time of closest approach (TCA): ${event.tca}
Miss distance (km): ${event.missDistanceKm}
Probability of collision: ${event.probability}

Run the 5-section simulation per your instructions and end with the CASCADE STATUS: line.`;
}

/* ------------------------------------------------------------
   4) Maneuver recommendation engine (POST /api/maneuver)

   Concrete, executable collision-avoidance burn plans. Given a
   satellite's TLE + the risk-scorer's assessment, Claude returns a
   6-section plan: primary burn, 2-3 alternatives, confidence,
   rationale, and a trailing RECOMMENDATION: action level.

   The model reasons from first-principles orbital mechanics
   (Hohmann transfer, vis-viva, Tsiolkovsky for hydrazine fuel).
   Output is plain text so it renders cleanly in a monospace panel.
   ------------------------------------------------------------ */

export const MANEUVER_RECOMMENDATION_PROMPT = `You are a flight dynamics engineer at a satellite operations center, generating concrete collision-avoidance maneuver plans for operators. You reason from first-principles orbital mechanics — Hohmann transfers, vis-viva, the Clohessy-Wiltshire equations, and the Tsiolkovsky rocket equation — to produce executable burn recommendations.

You write tight maneuver plans in PLAIN TEXT, UNDER 350 WORDS TOTAL, in this EXACT structure (use these exact uppercase headers, each on its own line):

PRIMARY MANEUVER
Direction: <PROGRADE | RETROGRADE | NORMAL | ANTI-NORMAL>
Delta-V: <number> m/s
Burn window: <time relative to TCA, e.g. "TCA - 8 hours">
Fuel: <number> kg hydrazine
Post-maneuver miss distance: <number> km

ALTERNATIVE 1
Direction: <...>
Delta-V: <number> m/s
Burn window: <...>
Fuel: <number> kg hydrazine
Post-maneuver miss distance: <number> km

ALTERNATIVE 2
Direction: <...>
Delta-V: <number> m/s
Burn window: <...>
Fuel: <number> kg hydrazine
Post-maneuver miss distance: <number> km

(Include ALTERNATIVE 3 only if it represents a genuinely distinct trade-off.)

CONFIDENCE
<integer 0-100>% — <one sentence justifying the confidence level based on data quality, orbital determinism, and TCA proximity>

RATIONALE
<2-3 sentences justifying the primary recommendation: why this direction, why this delta-V, why this window>

End your response with EXACTLY this final line, on its own line, no markdown, no extra punctuation:
RECOMMENDATION: [MONITOR|PREPARE|EXECUTE|EMERGENCY]

Decision criteria for the trailing recommendation:
- MONITOR: collisionProbability score < 30 — keep tracking, no maneuver required.
- PREPARE: score 30-59 — pre-load the burn, await refined CDM data.
- EXECUTE: score 60-84 — execute the primary maneuver inside the burn window above.
- EMERGENCY: score >= 85 OR overallThreat is CRITICAL — execute immediately, expedite ground confirmation.

Engineering rules:
- Delta-V should be the SMALLEST that puts post-maneuver miss distance above ~25 km (industry safe-pass threshold).
- PROGRADE adds altitude / period; RETROGRADE subtracts. NORMAL / ANTI-NORMAL rotate the orbital plane (use only when the conjunction geometry favors a cross-track separation).
- Earlier burns require less delta-V (orbital mechanics leverage); prefer windows at TCA - 6h or earlier when feasible.
- Assume satellite wet mass 1000 kg and Isp 220 s for hydrazine fuel estimates unless the input states otherwise. State the assumption inside the RATIONALE section if it materially affects the plan.
- Alternatives must explore DIFFERENT trade-offs (e.g. later/smaller burn, different direction, different miss-distance target).
- If a number cannot be computed from the input, write "n/a" — NEVER invent values.

Plain text only. No JSON, no code fences, no markdown beyond the section headers.`;

/**
 * Build the maneuver user prompt from a satellite's risk-score data
 * and (optionally) its raw TLE lines. The trailing RECOMMENDATION
 * line in Claude's response is regex-extracted server-side.
 */
export function buildManeuverUserPrompt(req: ManeuverRequest): string {
  const tleBlock =
    req.tleLine1 && req.tleLine2
      ? `\nTLE Line 1: ${req.tleLine1}\nTLE Line 2: ${req.tleLine2}`
      : "";

  return `Generate a collision-avoidance maneuver plan for the following satellite.

SATELLITE
Name: ${req.satelliteName}
NORAD ID: ${req.noradId}
Altitude (km): ${req.altitudeKm}
Orbital period (min): ${req.periodMinutes}
Inclination (deg): ${req.inclinationDeg}${tleBlock}

RISK ASSESSMENT (from the AI risk scorer)
Overall threat: ${req.overallThreat}
Collision probability score (0-100): ${req.collisionProbability}
Debris density score (0-100): ${req.debrisDensity}
Orbital stability score (0-100, higher = more stable): ${req.orbitalStability}
Closest approach: ${req.closestApproach}

Produce the 6-section maneuver plan per your instructions and end with the RECOMMENDATION: line.`;
}
