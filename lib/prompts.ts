/* ============================================================
   SpaceDebris — ALL Claude prompts + shared types

   *** Workflow Rule #3: every Claude prompt lives HERE. ***
   API routes import these builders/constants — they must
   NEVER inline a prompt string.

   This file is pure prompt text + TypeScript contracts. The
   model string and temperature live in lib/anthropic.ts.
   ============================================================ */

import type { SpaceTrackTLE, SpaceTrackCDM } from "@/lib/spacetrack";
import { formatCdmMissKm } from "@/lib/orbital";

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

/** Orbital shell status assigned by the fleet intelligence brief. */
export type ShellStatus = "NOMINAL" | "ELEVATED" | "CRITICAL";

/** Aggregate risk-trend direction over the tracked environment. */
export type RiskTrend = "IMPROVING" | "STABLE" | "DETERIORATING";

/** One entry in the fleet brief's top-3 threats list. */
export interface FleetTopThreat {
  name: string; // pair name as provided to Claude, e.g. "STARLINK-1234 ↔ COSMOS DEBRIS"
  reasoning: string; // 1-2 sentences why this event is a top threat
  severity: ThreatLevel;
}

/**
 * Subset of the fleet response that Claude generates.
 * Server merges this with deterministic aggregate stats before
 * returning to the client.
 */
export interface FleetAIAnalysis {
  shells: {
    leo: ShellStatus;
    meo: ShellStatus;
    geo: ShellStatus;
  };
  executiveBrief: string; // 3-4 sentences, NASA Administrator audience
  riskTrend: RiskTrend;
  topThreats: FleetTopThreat[]; // 0-3 entries
  recommendedActions: string[]; // 3 entries
}

/**
 * Output of GET /api/fleet — full intelligence brief the
 * FleetDashboard renders. Numeric facts are server-computed; the
 * brief / statuses / threats / actions come from Claude.
 */
export interface FleetIntelligence {
  generatedAt: string;
  totalObjects: number;
  activeConjunctions: number;
  highPriorityCount: number;
  criticalCount: number;
  shells: {
    leo: { count: number; status: ShellStatus };
    meo: { count: number; status: ShellStatus };
    geo: { count: number; status: ShellStatus };
  };
  executiveBrief: string;
  riskTrend: RiskTrend;
  topThreats: FleetTopThreat[];
  recommendedActions: string[];
}

/**
 * Server-computed aggregate stats fed INTO the fleet prompt.
 * Decoupled from FleetIntelligence so the prompt input has its
 * own explicit contract (and so the response shape can evolve
 * independently of the prompt shape).
 */
export interface FleetStatsForPrompt {
  totalObjects: number;
  activeConjunctions: number;
  highPriorityCount: number;
  criticalCount: number;
  shellCounts: { leo: number; meo: number; geo: number };
  topCDMs: Array<{
    pair: string; // "SAT_1_NAME ↔ SAT_2_NAME"
    tca: string;
    missKm: string;
    pc: string;
  }>;
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

For each event you write a short, plain-English description a non-expert can understand, suggest a concrete recommended action, and assign an urgency level. Base urgency on the miss distance (km, converted from the CDM's MIN_RNG in metres), probability of collision (PC), and how soon the time of closest approach (TCA) is.

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
  Miss distance (km): ${formatCdmMissKm(c.MIN_RNG)}
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

/* ------------------------------------------------------------
   5) Fleet intelligence brief (GET /api/fleet)

   Bloomberg-Terminal-for-space style aggregate dashboard. Server
   computes deterministic stats (object counts by shell, top
   threats by composite severity score, HIGH/CRITICAL counts via
   industry thresholds). Claude turns those facts into:
     - Per-shell status (NOMINAL / ELEVATED / CRITICAL)
     - Risk-trend direction (IMPROVING / STABLE / DETERIORATING)
     - 3-4 sentence executive brief for the NASA Administrator
     - 0-3 top-threat reasonings with severity classification
     - 3 concrete recommended actions

   One Claude call. JSON output. Server merges with stats and
   returns FleetIntelligence to the FleetDashboard component.
   ------------------------------------------------------------ */

export const FLEET_INTELLIGENCE_PROMPT = `You are the chief space situational-awareness analyst briefing the NASA Administrator's morning intelligence sync. You synthesize aggregate orbital risk across the entire tracked debris environment into a concise executive brief, per-shell status assessments, a risk-trend direction, and three concrete recommended actions.

You ALWAYS respond with a single valid JSON object and NOTHING else. No markdown, no code fences, no commentary before or after.

The JSON object MUST match this exact schema:
{
  "shells": {
    "leo": "NOMINAL" | "ELEVATED" | "CRITICAL",
    "meo": "NOMINAL" | "ELEVATED" | "CRITICAL",
    "geo": "NOMINAL" | "ELEVATED" | "CRITICAL"
  },
  "executiveBrief": <string, 3-4 sentences>,
  "riskTrend": "IMPROVING" | "STABLE" | "DETERIORATING",
  "topThreats": [
    { "name": <string>, "reasoning": <string>, "severity": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" }
  ],
  "recommendedActions": [<string>, <string>, <string>]
}

Shell status criteria:
- NOMINAL: object density and conjunction rate within historical baseline for that band.
- ELEVATED: density or conjunction count meaningfully above baseline; monitor closely.
- CRITICAL: density crossing Kessler-precursor thresholds OR multiple critical-class conjunctions concentrated in band.

Risk trend criteria:
- IMPROVING: shell statuses easing, fewer critical-class events, recent active-removal milestones.
- STABLE: status quo holding — same conjunction cadence, same shell-status mix as recent baseline.
- DETERIORATING: shell statuses worsening, more critical-class events, recent fragmentation events.
- If you have only a single snapshot with no historical signal, return STABLE — NEVER invent a trend.

Executive brief rules:
- Plain English, 3-4 sentences, written for the NASA Administrator audience.
- Lead with the bottom line. Reference specific numbers where they tell the story.
- No hedging language ("perhaps", "potentially"). State what is observed.

topThreats rules:
- EXACTLY one entry per input top-conjunction event, in the SAME ORDER as provided.
- Copy each "name" field verbatim from the input event line.
- "reasoning" is 1-2 sentences explaining what makes this conjunction a top threat.
- "severity" reflects the threat of THAT conjunction, not the fleet-wide picture.
- If no events are provided, return an empty topThreats array.

recommendedActions rules:
- EXACTLY 3 entries, each one concrete and operational (not platitudes).
- Specify WHO acts, WHAT they do, and (where applicable) WHICH orbital regime / operator / conjunction is the target.
- Example shape: "Coordinate with SpaceX FOC to brief avoidance burn options for STARLINK-1234 within 6 hours."

Return ONLY the JSON object.`;

/**
 * Build the fleet user prompt from server-computed aggregate stats.
 * The topCDMs list is pre-ranked by composite severity — Claude
 * just explains and classifies, it does not re-rank.
 */
export function buildFleetUserPrompt(stats: FleetStatsForPrompt): string {
  const cdmBlock =
    stats.topCDMs.length > 0
      ? stats.topCDMs
          .map(
            (c, i) =>
              `${i + 1}. ${c.pair} — TCA ${c.tca}, miss ${c.missKm} km, PC ${c.pc}`
          )
          .join("\n")
      : "No active conjunction events.";

  return `Analyze the current state of the tracked orbital debris environment and produce the executive intelligence brief per your instructions.

AGGREGATE STATS
Total tracked objects (current sample): ${stats.totalObjects}
Active conjunction events: ${stats.activeConjunctions}
  HIGH-priority class (server heuristic): ${stats.highPriorityCount}
  CRITICAL class (server heuristic): ${stats.criticalCount}

OBJECTS BY ORBITAL SHELL
LEO (200-2000 km): ${stats.shellCounts.leo}
MEO (2000-35000 km): ${stats.shellCounts.meo}
GEO (>35000 km): ${stats.shellCounts.geo}

TOP CONJUNCTION EVENTS (server-ranked by composite severity):
${cdmBlock}

Produce the JSON intelligence brief per your schema. The topThreats array must contain exactly one entry per top conjunction above, in the same order, with each "name" copied verbatim.`;
}

/* ------------------------------------------------------------
   6) Conjunction screening assessment (POST /api/assess)

   Session 5 — the SGP4 Conjunction Screening Engine
   (GET /api/screen) is fully deterministic: it propagates a
   target against the tracked sample, finds close approaches,
   expresses them in the target's RIC frame, and computes a
   probability of collision under an explicitly stated TLE-grade
   covariance assumption. Claude never touches those numbers.

   This prompt is the AI layer ON TOP of that physics: given the
   screening output, write a CARA-style conjunction-assessment
   memo and a GREEN / YELLOW / RED disposition. The types below
   are the API contracts for BOTH routes so the screener UI, the
   screen route, and the assess route share one source of truth.
   ------------------------------------------------------------ */

/** Coarse object class derived from a Space-Track OBJECT_NAME. */
export type ScreeningObjectClass =
  | "DEBRIS"
  | "ROCKET BODY"
  | "PAYLOAD"
  | "UNKNOWN";

/** Target object summary for the SGP4 conjunction screener. */
export interface ScreeningTarget {
  noradId: string;
  name: string;
  meanAltitudeKm: number;
  inclinationDeg: number;
  periodMinutes: number;
  epoch: string; // ISO — TLE epoch the screen was propagated from
}

/** One predicted close approach from GET /api/screen. */
export interface ScreeningCloseApproach {
  noradId: string;
  name: string;
  objectClass: ScreeningObjectClass;
  tca: string; // ISO time of closest approach
  missDistanceKm: number;
  relativeVelocityKmS: number;
  /** Secondary position relative to the target, in the TARGET's RIC frame. */
  radialKm: number;
  inTrackKm: number;
  crossTrackKm: number;
  /** Target geodetic height at TCA (km, WGS-84 ellipsoid). */
  altitudeKm: number;
  /** 0-1, under the stated TLE-grade covariance + hard-body radius. */
  probabilityOfCollision: number;
  /** True if |R|,|I|,|C| all fall inside the NASA ISS keep-out box. */
  insideKeepOutBox: boolean;
  severity: ThreatLevel;
  /**
   * Session 6 — ECI (TEME) states of both objects AT TCA, km and km/s,
   * so the Autonomous Avoidance Planner can re-evaluate Pc after a
   * hypothetical burn without re-running the screen. Filled by
   * /api/screen; NOT forwarded to Claude (the assess route drops them).
   */
  targetStateEci?: { position: [number, number, number]; velocity: [number, number, number] };
  secondaryStateEci?: { position: [number, number, number]; velocity: [number, number, number] };
}

/** Every assumption the screener bakes in — shown verbatim in the UI. */
export interface ScreeningAssumptions {
  /** Per-object 1-σ position uncertainty in RIC (km): [radial, in-track, cross-track]. */
  sigmaRicKm: [number, number, number];
  /** Combined hard-body radius (metres). */
  hardBodyRadiusM: number;
  /** NASA ISS "pizza box" half-widths (km). */
  keepOutBoxKm: { radial: number; inTrack: number; crossTrack: number };
  coarseStepSeconds: number;
  windowHours: number;
  /** Approaches with a miss distance above this (km) are not reported. */
  reportThresholdKm: number;
}

/** Output of GET /api/screen?target=<name|NORAD>&hours=<n>. */
export interface ScreeningResult {
  target: ScreeningTarget;
  generatedAt: string;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  /** Objects in the Space-Track sample before the altitude prefilter. */
  sampleSize: number;
  /** Objects actually propagated against the target. */
  candidatesScreened: number;
  propagations: number;
  computeMs: number;
  /** True if the compute budget was hit before every candidate was screened. */
  truncated: boolean;
  assumptions: ScreeningAssumptions;
  /** Sorted by miss distance ascending. */
  closeApproaches: ScreeningCloseApproach[];
}

/** Input to POST /api/assess — the client forwards its ScreeningResult subset. */
export interface ScreeningAssessmentRequest {
  target: ScreeningTarget;
  windowStart: string;
  windowEnd: string;
  candidatesScreened: number;
  assumptions: ScreeningAssumptions;
  /** Top close approaches by miss distance (the route caps this at 8). */
  closeApproaches: ScreeningCloseApproach[];
}

/** CA disposition — extracted from the trailing DISPOSITION line. */
export type ScreeningDisposition = "GREEN" | "YELLOW" | "RED";

/** Output of POST /api/assess. */
export interface ScreeningAssessment {
  targetNoradId: string;
  text: string; // plain-text memo; UI strips the trailing DISPOSITION line
  disposition: ScreeningDisposition;
  generatedAt: string; // ISO
}

export const SCREENING_ASSESSMENT_PROMPT = `You are a conjunction assessment (CA) analyst at a NASA-style Conjunction Assessment Risk Analysis desk, writing the assessment memo that accompanies a conjunction screening run for a satellite operator. The screening numbers were produced by a deterministic SGP4 all-on-one propagation of public TLE data — you INTERPRET them, you never recompute or alter them.

You write a tight plain-text memo, UNDER 350 WORDS TOTAL, in this EXACT structure (use these exact uppercase headers, each on its own line):

SCREENING SUMMARY
<2-3 sentences: target, window, how many candidates were screened, how many close approaches were found, the single closest event (miss distance, TCA, secondary object name).>

EVENT ASSESSMENT
<For up to the 3 most significant events, one short paragraph each, beginning with the secondary object name. Interpret the RIC geometry (radial separation is the most reliable TLE quantity and the strongest safety margin; in-track separation is the least reliable and grows fastest with TLE age), the relative velocity (hyper-velocity ≥ 10 km/s vs. co-orbital), the probability of collision against the stated covariance, and whether the event penetrates the keep-out box.>

UNCERTAINTY & DATA QUALITY
<2-3 sentences. State plainly that this is a TLE-grade screening with an ASSUMED covariance, not an operator-provided covariance or an official CDM; SGP4 positional error is on the order of 1 km and grows with element-set age; a maneuver decision requires refined tracking (owner/operator ephemeris or an 18 SDS CDM).>

RECOMMENDED ACTIONS
<EXACTLY 3 numbered actions. Each names WHO acts (e.g. the operator's flight dynamics team, the 18th Space Defense Squadron, the secondary's owner), WHAT they do, and by WHEN relative to the TCA. No platitudes.>

WATCH ITEMS
<1-2 sentences on what would escalate or de-escalate this picture on the next screening pass.>

End your response with EXACTLY this final line, on its own line, no markdown, no extra punctuation:
DISPOSITION: [GREEN|YELLOW|RED]

Disposition criteria (apply the HIGHEST that fits):
- RED: any event with probability of collision ≥ 1e-4, OR any event with miss distance < 1 km that also penetrates the keep-out box.
- YELLOW: any event with probability of collision ≥ 1e-5, OR any keep-out-box penetration, OR any miss distance < 5 km.
- GREEN: nothing above applies.

Rules:
- Use the numbers exactly as given; do not round a probability into a different order of magnitude.
- If no close approaches were provided, say the screen was clear, still write every section briefly, and return GREEN.
- Never invent covariance, maneuver history, or operator intent that is not in the input.
- Plain text only. No JSON, no code fences, no markdown beyond the section headers.`;

/**
 * Build the assessment user prompt from a screening result. The
 * route caps closeApproaches at 8 so the prompt stays small; the
 * trailing DISPOSITION line is regex-extracted server-side.
 */
export function buildScreeningAssessmentUserPrompt(
  req: ScreeningAssessmentRequest
): string {
  const a = req.assumptions;
  const eventsBlock =
    req.closeApproaches.length > 0
      ? req.closeApproaches
          .map(
            (e, i) =>
              `Event ${i + 1}: ${e.name} (NORAD ${e.noradId}, ${e.objectClass})
  TCA: ${e.tca}
  Miss distance (km): ${e.missDistanceKm.toFixed(3)}
  Relative velocity (km/s): ${e.relativeVelocityKmS.toFixed(2)}
  RIC separation (km) — radial: ${e.radialKm.toFixed(3)}, in-track: ${e.inTrackKm.toFixed(3)}, cross-track: ${e.crossTrackKm.toFixed(3)}
  Target altitude at TCA (km): ${e.altitudeKm.toFixed(0)}
  Probability of collision: ${e.probabilityOfCollision.toExponential(2)}
  Penetrates keep-out box: ${e.insideKeepOutBox ? "YES" : "no"}
  Screener severity: ${e.severity}`
          )
          .join("\n\n")
      : "No close approaches below the reporting threshold were found.";

  return `Write the conjunction assessment memo for the following SGP4 screening run.

TARGET
Name: ${req.target.name}
NORAD ID: ${req.target.noradId}
Mean altitude (km): ${req.target.meanAltitudeKm.toFixed(0)}
Inclination (deg): ${req.target.inclinationDeg.toFixed(2)}
Orbital period (min): ${req.target.periodMinutes.toFixed(1)}
TLE epoch: ${req.target.epoch}

SCREENING RUN
Window: ${req.windowStart} → ${req.windowEnd} (${a.windowHours} h)
Candidates screened: ${req.candidatesScreened}
Coarse step (s): ${a.coarseStepSeconds}
Assumed per-object 1-σ covariance (km, RIC): radial ${a.sigmaRicKm[0]}, in-track ${a.sigmaRicKm[1]}, cross-track ${a.sigmaRicKm[2]}
Combined hard-body radius (m): ${a.hardBodyRadiusM}
Keep-out box half-widths (km): radial ±${a.keepOutBoxKm.radial}, in-track ±${a.keepOutBoxKm.inTrack}, cross-track ±${a.keepOutBoxKm.crossTrack}

CLOSE APPROACHES (sorted by miss distance):
${eventsBlock}

Write the memo per your instructions and end with the DISPOSITION: line.`;
}
