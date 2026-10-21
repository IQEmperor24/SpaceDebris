/* ============================================================
   SpaceDebris — public API description (Session 6, Feature 5)

   ONE source of truth for:
     - API_ENDPOINTS  — flat, UI-friendly list rendered by /docs
                        (app/docs/page.tsx, a server component)
     - OPENAPI_SPEC   — the OpenAPI 3.1 document served by
                        GET /api/openapi
   OPENAPI_SPEC.paths is BUILT from API_ENDPOINTS (buildOpenApiSpec),
   so the docs page and the machine-readable spec can never drift.

   Purity: no browser or server-only imports. Value imports are the
   SAME constants the code enforces, so the docs cannot drift from it:
     - lib/rateLimit.ts  API_RATE_LIMIT / API_EXPENSIVE_RATE_LIMIT and
                         rateLimitTier() — each endpoint's documented
                         tier is the classifier's verdict on that
                         endpoint's own example request
     - lib/screening.ts  SCREENING_WINDOW_OPTIONS (/api/screen hours)
     - lib/launch.ts     LAUNCH_SITES, TARGET_ORBITS, COLA_WINDOW_OPTIONS,
                         colaAssumptions (/api/cola ids + model constants)
   All three are pure modules (satellite.js underneath, no env, no
   network), so this file stays safe for the /docs server component
   and the /api/openapi route.

   Every request/response shape below was read off the route source
   (app/api/<name>/route.ts) and the contracts in lib/prompts.ts,
   lib/iss.ts, lib/spaceweather.ts, lib/health.ts. Response examples
   are ILLUSTRATIVE and abbreviated (one array element, short text)
   — they show shapes and field names, not live data.

   Cost column = Anthropic token spend only. "deterministic" routes
   make no Claude call (they may still call Space-Track or NOAA,
   which are free but rate-limited). Dollar figures are the
   project's own per-call estimates, not invoices.
   ============================================================ */

import {
  API_EXPENSIVE_RATE_LIMIT,
  API_RATE_LIMIT,
  DEBRIS_CACHED_LIMITS,
  RATE_LIMIT_TIERS,
  rateLimitTier,
  requestsPerMinute,
  type RateLimitTier,
} from "@/lib/rateLimit";
import { SCREENING_WINDOW_OPTIONS } from "@/lib/screening";
import { COLA_WINDOW_OPTIONS, LAUNCH_SITES, TARGET_ORBITS, colaAssumptions } from "@/lib/launch";

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

export type ApiMethod = "GET" | "POST";
export type ApiParamLocation = "query" | "body";
export type ApiCost = "deterministic" | "claude";
export type ApiParamType = "string" | "integer" | "number" | "boolean" | "object" | "array";

export interface ApiParam {
  name: string;
  in: ApiParamLocation;
  type: ApiParamType;
  required: boolean;
  description: string;
  example?: string;
  /** Allowed values (as strings, even for integer params). */
  enum?: readonly string[];
  /** Server default when the parameter is omitted. */
  default?: string;
  /** Max string length the route accepts. */
  maxLength?: number;
  /** JSON Schema format, e.g. "date-time". */
  format?: string;
}

export interface ApiErrorCode {
  status: number;
  description: string;
}

/** Rate-limit tier of one endpoint (middleware.ts, lib/rateLimit.ts). */
export interface ApiRateLimit {
  tier: RateLimitTier;
  /** Burst (bucket capacity) of that tier. */
  burst: number;
  /** Sustained requests per minute of that tier. */
  perMinute: number;
  /** When some parameter values put a request in the other tier. */
  note?: string;
}

export interface ApiEndpoint {
  /** Stable id: anchor on /docs and OpenAPI example key. */
  id: string;
  method: ApiMethod;
  path: string;
  /** OpenAPI tag (domain grouping). */
  tag: string;
  summary: string;
  description: string;
  params: ApiParam[];
  /** Pretty JSON request body for POST routes (same body the curl sends). */
  requestExample?: string;
  /** Pretty JSON, abbreviated, illustrative. */
  responseExample: string;
  cost: ApiCost;
  /** Human-readable cost note, e.g. "$0 — pure SGP4" or "~$0.006 / call (est.)". */
  costEstimate: string;
  cache: string;
  /** External systems this route talks to. */
  upstream: string[];
  /** Non-200 statuses the route itself returns (429 / 403 from middleware are global). */
  errors: ApiErrorCode[];
  curl: string;
  /** Tier = rateLimitTier() applied to this endpoint's example request. */
  rateLimit: ApiRateLimit;
}

/** Minimal JSON Schema subset used by this document. */
export interface JsonSchema {
  type?: ApiParamType;
  description?: string;
  enum?: ReadonlyArray<string | number>;
  default?: string | number;
  example?: unknown;
  minimum?: number;
  maxLength?: number;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  $ref?: string;
}

export interface OpenApiRef {
  $ref: string;
}

export interface OpenApiParameter {
  name: string;
  in: "query";
  required: boolean;
  description: string;
  schema: JsonSchema;
  example?: string | number;
}

export interface OpenApiExample {
  summary: string;
  value: unknown;
}

export interface OpenApiMediaType {
  schema: JsonSchema;
  example?: unknown;
  examples?: Record<string, OpenApiExample>;
}

export interface OpenApiResponse {
  description: string;
  headers?: Record<string, OpenApiRef>;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: boolean;
    content: Record<string, OpenApiMediaType>;
  };
  responses: Record<string, OpenApiResponse | OpenApiRef>;
  "x-cost": ApiCost;
  "x-cost-estimate": string;
  "x-cache": string;
  "x-upstream": string[];
  /** One entry per documented mode (endpoint id) of this operation. */
  "x-rate-limit": Array<ApiRateLimit & { endpoint: string }>;
}

export interface OpenApiHeader {
  description: string;
  schema: JsonSchema;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    summary: string;
    description: string;
    license: { name: string; url: string };
  };
  servers: Array<{ url: string; description: string }>;
  /** Empty = explicitly public: no operation needs credentials. */
  security: Array<Record<string, string[]>>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, { get?: OpenApiOperation; post?: OpenApiOperation }>;
  components: {
    schemas: Record<string, JsonSchema>;
    headers: Record<string, OpenApiHeader>;
    responses: Record<string, OpenApiResponse>;
  };
}

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

export const API_BASE_URL = "https://space-debris-two.vercel.app";
export const API_VERSION = "0.1.0"; // matches package.json

export const API_REPOSITORY_URL = "https://github.com/IQEmperor24/SpaceDebris";

/** Sustained requests/minute implied by the token-bucket refill. */
export const API_RATE_LIMIT_PER_MINUTE = requestsPerMinute(API_RATE_LIMIT);
/** Sustained requests/minute of the expensive tier. */
export const API_EXPENSIVE_RATE_LIMIT_PER_MINUTE = requestsPerMinute(API_EXPENSIVE_RATE_LIMIT);

/** What puts a request in the expensive tier (mirrors rateLimitTier in lib/rateLimit.ts). */
export const EXPENSIVE_TIER_SCOPE =
  "every POST (all Claude-backed), GET /api/screen and GET /api/cola (uncached Space-Track " +
  "lookup and/or up to ~20 s of server CPU per call), and GET /api/debris with `search` or " +
  `with a \`limit\` other than ${DEBRIS_CACHED_LIMITS.join(" or ")} (a fresh Space-Track query)`;

export const RATE_LIMIT_POLICY =
  `Token buckets per client IP (IPv6: per /64). Every /api/* request spends from the general ` +
  `bucket: burst ${API_RATE_LIMIT.capacity}, refill ${API_RATE_LIMIT.refillPerSecond}/s ` +
  `(${API_RATE_LIMIT_PER_MINUTE} requests/min sustained). Expensive requests — ${EXPENSIVE_TIER_SCOPE} — ` +
  `must also pass a stricter bucket: burst ${API_EXPENSIVE_RATE_LIMIT.capacity}, ` +
  `${API_EXPENSIVE_RATE_LIMIT_PER_MINUTE} requests/min. Responses carry X-RateLimit-Tier plus ` +
  "X-RateLimit-Limit / X-RateLimit-Remaining of the bucket that applies; an empty bucket returns " +
  "429 { error, retryAfterSeconds } with a Retry-After header. Enforced in Edge middleware per " +
  "instance — best-effort, not a global guarantee.";

export const CORS_POLICY =
  "GET and HEAD responses carry Access-Control-Allow-Origin: *, and preflights asking for GET " +
  "or HEAD are answered with 204 and the same header. Preflights for POST get no CORS headers, " +
  "so browsers refuse cross-origin POSTs, and a POST whose Origin header names another host is " +
  "rejected with 403 before it reaches a route. Server-side callers such as curl send no Origin " +
  "and are unaffected.";

export const API_DISCLAIMER =
  "Screening results, Pc values, maneuver trades and COLA verdicts are estimates under stated " +
  "assumptions on public Space-Track element sets — not 18 SDS CDMs, not an operational " +
  "conjunction-assessment service and not flight software.";

/* ------------------------------------------------------------
   Illustrative example data (shared across examples)
   ------------------------------------------------------------ */

const EX_TIME = "2024-01-01T12:00:00.000Z";
const EX_TCA = "2024-01-02T03:17:42.315Z";

/**
 * Representative ISS gp row: the orbital elements of the repo's test
 * fixture (synthetic round epoch 2024-01-01 12:00 UTC), with the TLE
 * modulo-10 checksum digits corrected so the lines validate.
 */
const EX_ISS_TLE = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  NORAD_CAT_ID: "25544",
  EPOCH: "2024-01-01T12:00:00.000000",
  TLE_LINE1: "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9997",
  TLE_LINE2: "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.49560532 25006",
  INCLINATION: "51.6400",
  RA_OF_ASC_NODE: "208.9163",
  ECCENTRICITY: "0.0006703",
  ARG_OF_PERICENTER: "130.5360",
  MEAN_ANOMALY: "325.0288",
  MEAN_MOTION: "15.49560532",
  SEMIMAJOR_AXIS: "6796.148",
  PERIOD: "92.930",
  APOAPSIS: "422.566",
  PERIAPSIS: "413.455",
};

const EX_SCREEN_TARGET = {
  noradId: "25544",
  name: "ISS (ZARYA)",
  meanAltitudeKm: 418.0,
  inclinationDeg: 51.64,
  periodMinutes: 92.93,
  epoch: "2024-01-01T12:00:00.000Z",
};

const EX_SCREEN_ASSUMPTIONS = {
  sigmaRicKm: [0.3, 1.0, 0.3],
  hardBodyRadiusM: 20,
  keepOutBoxKm: { radial: 2, inTrack: 25, crossTrack: 25 },
  coarseStepSeconds: 60,
  windowHours: 24,
  reportThresholdKm: 50,
};

/*
 * Screening example, generated OFFLINE with lib/orbital and hard-coded:
 * - targetStateEci = SGP4 state of EX_ISS_TLE at EX_TCA (propagateAt);
 *   h = r × v gives 51.63° — the documented target.inclinationDeg.
 * - secondaryStateEci = synthetic circular-speed state on an 82.6° orbit
 *   (the Cosmos 1408 debris family), southbound, 3.0 km from the target
 *   with the miss vector ⊥ relative velocity (a true TCA).
 * - Every metric below is recomputed from the ROUNDED vectors: miss
 *   (|d|), relative speed, RIC in the target frame (ricFrame / toRic),
 *   geodetic altitude of the target, Pc (probabilityOfCollision with the
 *   EX_SCREEN_ASSUMPTIONS covariance) and the keep-out-box test: |R| =
 *   2.298 km > 2 km puts it just OUTSIDE the box, so the grade is MEDIUM
 *   (< 10 km, Pc < 1e-5, no box penetration).
 */
const EX_SCREEN_TARGET_STATE = {
  position: [-2228.49, -4808.38, 4244.899],
  velocity: [6.7553, 0.0808, 3.62],
};
const EX_SCREEN_SECONDARY_STATE = {
  position: [-2229.177, -4805.597, 4244.015],
  velocity: [-0.8413, -4.819, -5.8985],
};

const EX_SCREEN_APPROACH = {
  noradId: "49863",
  name: "COSMOS 1408 DEB",
  objectClass: "DEBRIS",
  tca: EX_TCA,
  missDistanceKm: 3.0,
  relativeVelocityKmS: 13.13,
  radialKm: -2.298,
  inTrackKm: -0.997,
  crossTrackKm: 1.65,
  altitudeKm: 420.4,
  probabilityOfCollision: 1.5e-11,
  insideKeepOutBox: false,
  severity: "MEDIUM",
};

const EX_CDM_ALERT = {
  cdmId: "812345678",
  sat1Name: "STARLINK-1234",
  sat1Id: "44935",
  sat2Name: "FENGYUN 1C DEB",
  sat2Id: "31141",
  tca: "2024-01-01T18:42:10.000000",
  missDistanceKm: "0.412",
  probability: "0.0000312",
};

/* ------------------------------------------------------------
   Builders for curl + examples
   ------------------------------------------------------------ */

/**
 * 2-space pretty JSON with all-number arrays kept on one line
 * ([0.3, 1, 0.3] instead of five lines). JSON.stringify escapes
 * newlines inside strings, so a raw newline is always structural and
 * only arrays of plain JSON numbers can match: output stays valid JSON.
 */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /\[\n\s*(-?\d[\d.eE+-]*(?:,\n\s*-?\d[\d.eE+-]*)*)\n\s*\]/g,
    (_match, items: string) => `[${items.split(/,\n\s*/).join(", ")}]`
  );
}

/** POSIX single-quote a string for a shell command line. */
function shellQuote(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function curlGet(path: string, query?: Record<string, string>): string {
  const qs = query ? new URLSearchParams(query).toString() : "";
  return `curl -s "${API_BASE_URL}${path}${qs ? `?${qs}` : ""}"`;
}

function curlPost(path: string, body: unknown): string {
  return [
    `curl -s -X POST "${API_BASE_URL}${path}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellQuote(pretty(body))}`,
  ].join("\n");
}

const ERR_500 = (what: string): ApiErrorCode => ({
  status: 500,
  description: `${what} — { error, detail }.`,
});

interface EndpointDef extends Omit<ApiEndpoint, "responseExample" | "requestExample" | "curl" | "rateLimit"> {
  response: unknown;
  /** Shown with the rate-limit tier when some parameter values change it. */
  rateLimitNote?: string;
  /** Query used for the curl example (GET). */
  query?: Record<string, string>;
  /** Body used for the curl + request example (POST). */
  body?: unknown;
}

function toEndpoint(def: EndpointDef): ApiEndpoint {
  const { response, query, body, rateLimitNote, ...rest } = def;
  // The documented tier is the middleware classifier's verdict on the
  // documented example request, so the two cannot disagree.
  const tier = rateLimitTier(def.method, def.path, new URLSearchParams(query ?? {}));
  const policy = RATE_LIMIT_TIERS[tier];
  const rateLimit: ApiRateLimit = {
    tier,
    burst: policy.capacity,
    perMinute: requestsPerMinute(policy),
  };
  if (rateLimitNote) rateLimit.note = rateLimitNote;
  const endpoint: ApiEndpoint = {
    ...rest,
    responseExample: pretty(response),
    curl: def.method === "POST" ? curlPost(def.path, body ?? {}) : curlGet(def.path, query),
    rateLimit,
  };
  if (def.method === "POST") endpoint.requestExample = pretty(body ?? {});
  return endpoint;
}

/* ------------------------------------------------------------
   Endpoint catalogue — EVERY route in app/api
   ------------------------------------------------------------ */

/* Allowed sets come from the libraries the routes validate against. */
const SCREEN_HOURS = SCREENING_WINDOW_OPTIONS.map(String);
const COLA_SITE_IDS = LAUNCH_SITES.map((site) => site.id);
const COLA_ORBIT_IDS = TARGET_ORBITS.map((orbit) => orbit.id);
const COLA_MINUTES = COLA_WINDOW_OPTIONS.map(String);
const EX_COLA_SITE = LAUNCH_SITES.find((site) => site.id === "slc-40") ?? LAUNCH_SITES[0];
const EX_COLA_ORBIT = TARGET_ORBITS.find((orbit) => orbit.id === "starlink-550") ?? TARGET_ORBITS[0];

const ENDPOINT_DEFS: EndpointDef[] = [
  /* ---------------- Catalog ---------------- */
  {
    id: "debris-list",
    method: "GET",
    path: "/api/debris",
    tag: "Catalog",
    summary: "Newest-epoch element-set sample (list mode)",
    description:
      "Returns the `limit` most recently updated objects from Space-Track's gp class " +
      "(newest EPOCH first) — the sample the 3D map and every catalog panel use. All " +
      "Space-Track fields are strings. The sample is dominated by recently updated payloads " +
      "(Starlink); it is not the ~46,000-object catalog.",
    params: [
      {
        name: "limit",
        in: "query",
        type: "integer",
        required: false,
        default: "500",
        example: "2000",
        description:
          "Rows to return. Non-numeric or ≤ 0 falls back to 500; the Space-Track client clamps " +
          "to 10,000. The dashboard uses 2000 — reuse it to share the server's cached sample.",
      },
    ],
    rateLimitNote:
      `Only limit ${DEBRIS_CACHED_LIMITS.join(" or ")} (or no limit) is in the general tier; any other ` +
      "value is a fresh Space-Track pull and uses the expensive tier.",
    query: { limit: "2000" },
    response: { count: 2000, objects: [EX_ISS_TLE] },
    cost: "deterministic",
    costEstimate: "$0 — no Claude call",
    cache: "10 min per limit (route) + shared per-instance Space-Track dataset cache",
    upstream: ["Space-Track.org gp"],
    errors: [ERR_500("Space-Track fetch failed")],
  },
  {
    id: "debris-search",
    method: "GET",
    path: "/api/debris",
    tag: "Catalog",
    summary: "Look up one object by name or NORAD ID (search mode)",
    description:
      "When `search` is present the route switches to single-object lookup: a numeric value " +
      "matches NORAD_CAT_ID, anything else is a wildcard OBJECT_NAME match ordered by newest " +
      "epoch. `object` is null (HTTP 200) when nothing matches. Note the bare word ISS also " +
      "matches ISS DEB objects by wildcard — use 25544 for the station.",
    params: [
      {
        name: "search",
        in: "query",
        type: "string",
        required: true,
        example: "25544",
        description: "Satellite name or NORAD catalog number. Takes precedence over `limit`.",
      },
    ],
    query: { search: "25544" },
    response: { object: EX_ISS_TLE },
    cost: "deterministic",
    costEstimate: "$0 — no Claude call",
    cache: "10 min per search term (route)",
    upstream: ["Space-Track.org gp"],
    errors: [ERR_500("Space-Track fetch failed")],
  },

  /* ---------------- Risk & maneuvers (Claude) ---------------- */
  {
    id: "analyze",
    method: "POST",
    path: "/api/analyze",
    tag: "Risk & maneuvers",
    summary: "AI collision-risk score for one satellite",
    description:
      "Resolves the object on Space-Track, gathers up to 15 objects within ±100 km of its mean " +
      "altitude from a 300-object sample, and asks Claude (temperature 0) for a scored risk " +
      "assessment: three 0-100 bars, a threat level and plain-English advice. The resolved " +
      "Space-Track row is attached as `tle` (all fields strings) so callers can chain " +
      "POST /api/maneuver without a second lookup. Scores are model judgement, not a computed Pc.",
    params: [
      {
        name: "query",
        in: "body",
        type: "string",
        required: true,
        example: "25544",
        description: "Satellite name (wildcard match) or NORAD catalog number.",
      },
    ],
    body: { query: "25544" },
    response: {
      collisionProbability: 12,
      debrisDensity: 46,
      orbitalStability: 88,
      overallThreat: "LOW",
      closestApproach: "4.1 km in 6.2 hours",
      recommendation: "No maneuver required; continue routine screening.",
      summary: "ISS operates in a moderately populated 420 km shell…",
      altitudeKm: 418,
      periodMinutes: 92.93,
      inclinationDeg: 51.64,
      tle: { OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: "25544", TLE_LINE1: "1 25544U …", TLE_LINE2: "2 25544 …" },
    },
    cost: "claude",
    costEstimate: "~$0.006 / call (est.)",
    cache: "None at the route — every call spends tokens (context sample uses the shared Space-Track cache)",
    upstream: ["Space-Track.org gp", "Anthropic Claude"],
    errors: [
      { status: 400, description: "Body is not JSON or `query` is missing — { error }." },
      { status: 404, description: "No catalog object matches `query` — { error }." },
      { status: 502, description: "Claude returned an unparseable score — { error, detail }." },
      ERR_500("Space-Track or Claude call failed"),
    ],
  },
  {
    id: "maneuver",
    method: "POST",
    path: "/api/maneuver",
    tag: "Risk & maneuvers",
    summary: "AI collision-avoidance maneuver plan",
    description:
      "Takes a risk score (as returned by POST /api/analyze) and asks Claude for a plain-text " +
      "plan — primary maneuver, alternatives, confidence, rationale — with hydrazine estimates " +
      "(Tsiolkovsky, Isp 220 s and 1,000 kg wet mass assumed) and a trailing " +
      "RECOMMENDATION line, extracted into `recommendation` (MONITOR | PREPARE | EXECUTE | " +
      "EMERGENCY; PREPARE when the line is missing). For the deterministic Clohessy-Wiltshire " +
      "trade study see the Avoidance Burn Planner panel on the dashboard.",
    params: [
      { name: "satelliteName", in: "body", type: "string", required: true, example: "ISS (ZARYA)", description: "Display name." },
      { name: "noradId", in: "body", type: "string", required: true, example: "25544", description: "NORAD catalog number." },
      { name: "altitudeKm", in: "body", type: "number", required: true, example: "418", description: "Mean altitude (km)." },
      { name: "periodMinutes", in: "body", type: "number", required: true, example: "92.93", description: "Orbital period (min)." },
      { name: "inclinationDeg", in: "body", type: "number", required: true, example: "51.64", description: "Inclination (deg)." },
      { name: "collisionProbability", in: "body", type: "number", required: true, example: "12", description: "0-100 score from /api/analyze (not a Pc)." },
      { name: "debrisDensity", in: "body", type: "number", required: true, example: "46", description: "0-100 score from /api/analyze." },
      { name: "orbitalStability", in: "body", type: "number", required: true, example: "88", description: "0-100 score from /api/analyze." },
      {
        name: "overallThreat",
        in: "body",
        type: "string",
        required: true,
        enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
        example: "MEDIUM",
        description: "Threat level from /api/analyze.",
      },
      { name: "closestApproach", in: "body", type: "string", required: true, example: "4.1 km in 6.2 hours", description: "Free-text closest approach from /api/analyze." },
      { name: "tleLine1", in: "body", type: "string", required: false, description: "Optional raw TLE line 1." },
      { name: "tleLine2", in: "body", type: "string", required: false, description: "Optional raw TLE line 2." },
    ],
    body: {
      satelliteName: "ISS (ZARYA)",
      noradId: "25544",
      altitudeKm: 418,
      periodMinutes: 92.93,
      inclinationDeg: 51.64,
      collisionProbability: 12,
      debrisDensity: 46,
      orbitalStability: 88,
      overallThreat: "MEDIUM",
      closestApproach: "4.1 km in 6.2 hours",
    },
    response: {
      satelliteName: "ISS (ZARYA)",
      text: "PRIMARY MANEUVER\nDirection: PROGRADE\n…\nRECOMMENDATION: PREPARE",
      recommendation: "PREPARE",
      generatedAt: EX_TIME,
    },
    cost: "claude",
    costEstimate: "~$0.008 / call (est.)",
    cache: "2 min per satelliteName | noradId | overallThreat | collisionProbability",
    upstream: ["Anthropic Claude"],
    errors: [
      { status: 400, description: "Missing / mistyped fields — { error } lists the required ones." },
      ERR_500("Claude call failed"),
    ],
  },

  /* ---------------- Conjunctions ---------------- */
  {
    id: "conjunctions",
    method: "GET",
    path: "/api/conjunctions",
    tag: "Conjunctions",
    summary: "Upcoming public CDMs with AI plain-English summaries",
    description:
      "The 10 soonest-TCA conjunction data messages from Space-Track's cdm_public class " +
      "(owner/operator-released messages only), merged with ONE batched Claude call that adds " +
      "`plainEnglish`, `recommendation` and `urgency`. CDM fields stay strings exactly as " +
      "Space-Track publishes them. No Claude call is made when the feed is empty.",
    params: [],
    response: {
      count: 10,
      alerts: [
        {
          ...EX_CDM_ALERT,
          plainEnglish: "A Starlink satellite passes 412 m from a Fengyun-1C fragment…",
          recommendation: "Operator should evaluate an avoidance maneuver.",
          urgency: "HIGH",
        },
      ],
    },
    cost: "claude",
    costEstimate: "~$0.04 / cache refresh (est., one batched call)",
    cache: "60 s (single key) — matches the dashboard's 60 s poll",
    upstream: ["Space-Track.org cdm_public", "Anthropic Claude"],
    errors: [ERR_500("Space-Track or Claude call failed")],
  },
  {
    id: "cascade",
    method: "POST",
    path: "/api/cascade",
    tag: "Conjunctions",
    summary: "AI Kessler-cascade scenario for one conjunction",
    description:
      "Takes one alert from GET /api/conjunctions and asks Claude for a 5-section worst-case " +
      "fragmentation narrative ending in a CASCADE STATUS line, extracted into `status` " +
      "(CONTAINED | WARNING | CRITICAL | CATASTROPHIC; WARNING when the line is missing). " +
      "Narrative scenario, not a debris-evolution model run.",
    params: [
      { name: "cdmId", in: "body", type: "string", required: true, example: "812345678", description: "CDM_ID of the alert." },
      { name: "sat1Name", in: "body", type: "string", required: true, example: "STARLINK-1234", description: "Primary object name." },
      { name: "sat1Id", in: "body", type: "string", required: true, example: "44935", description: "Primary NORAD ID." },
      { name: "sat2Name", in: "body", type: "string", required: true, example: "FENGYUN 1C DEB", description: "Secondary object name." },
      { name: "sat2Id", in: "body", type: "string", required: true, example: "31141", description: "Secondary NORAD ID." },
      { name: "tca", in: "body", type: "string", required: true, example: "2024-01-01T18:42:10.000000", description: "Time of closest approach as published." },
      { name: "missDistanceKm", in: "body", type: "string", required: true, example: "0.412", description: "Miss distance in km as a STRING (converted from the CDM's MIN_RNG, which Space-Track publishes in metres)." },
      { name: "probability", in: "body", type: "string", required: true, example: "0.0000312", description: "Pc — a STRING, as in the CDM." },
    ],
    body: EX_CDM_ALERT,
    response: {
      cdmId: "812345678",
      text: "1. INITIAL IMPACT\n…\nCASCADE STATUS: WARNING",
      status: "WARNING",
      generatedAt: EX_TIME,
    },
    cost: "claude",
    costEstimate: "~$0.008 / call (est.)",
    cache: "5 min per full event identity (cdmId | sat ids | tca | miss | Pc)",
    upstream: ["Anthropic Claude"],
    errors: [
      { status: 400, description: "Invalid JSON or a missing / non-string field — { error }." },
      ERR_500("Claude call failed"),
    ],
  },
  {
    id: "screen",
    method: "GET",
    path: "/api/screen",
    tag: "Conjunctions",
    summary: "Deterministic SGP4 conjunction screen of one target",
    description:
      "All-on-one screen of the target against the 2,000-object sample: perigee/apogee band " +
      "prefilter (±75 km) → 60 s coarse SGP4 sweep → golden-section refinement of each local " +
      "minimum → miss distance, relative velocity, RIC separation in the target frame, 2-D " +
      "encounter-plane Pc under an ASSUMED TLE-grade covariance (1-σ RIC 0.3 / 1.0 / 0.3 km per " +
      "object, hard-body radius 20 m) and the NASA ISS keep-out box test. Closest approach per " +
      "secondary, sorted by miss distance. The compute budget (≤ 20 s) sets `truncated` when " +
      "it trips. Each approach also carries both ECI (TEME) states at TCA.",
    params: [
      {
        name: "target",
        in: "query",
        type: "string",
        required: true,
        maxLength: 64,
        example: "ISS",
        description: "Satellite name or NORAD ID, 1-64 chars. The bare word ISS is aliased to NORAD 25544.",
      },
      {
        name: "hours",
        in: "query",
        type: "integer",
        required: false,
        enum: SCREEN_HOURS,
        default: "24",
        example: "24",
        description: "Screening window length from now (hours).",
      },
    ],
    query: { target: "ISS", hours: "24" },
    response: {
      target: EX_SCREEN_TARGET,
      generatedAt: EX_TIME,
      windowStart: EX_TIME,
      windowEnd: "2024-01-02T12:00:00.000Z",
      sampleSize: 2000,
      candidatesScreened: 412,
      propagations: 1268544,
      computeMs: 1384,
      truncated: false,
      assumptions: EX_SCREEN_ASSUMPTIONS,
      closeApproaches: [
        {
          ...EX_SCREEN_APPROACH,
          targetStateEci: EX_SCREEN_TARGET_STATE,
          secondaryStateEci: EX_SCREEN_SECONDARY_STATE,
        },
      ],
    },
    cost: "deterministic",
    costEstimate: "$0 — pure SGP4",
    cache: "5 min per target | hours (≤ 64 entries)",
    upstream: ["Space-Track.org gp"],
    errors: [
      { status: 400, description: `Missing / over-long target, or hours not in ${SCREEN_HOURS.join(" | ")} — { error }.` },
      { status: 404, description: "Target not found in the catalog — { error }." },
      ERR_500("Space-Track fetch or screening failed"),
    ],
  },
  {
    id: "assess",
    method: "POST",
    path: "/api/assess",
    tag: "Conjunctions",
    summary: "AI conjunction-assessment memo for a screening run",
    description:
      "Forward the corresponding fields of a GET /api/screen result. The body is validated " +
      "strictly (finite numbers, enum fields, ≤ 500 approaches) and the 8 lowest-miss " +
      "approaches are sent to Claude, which writes a CARA-style 5-section memo ending in a " +
      "DISPOSITION line → `disposition` GREEN | YELLOW | RED (YELLOW when missing). Claude " +
      "interprets the screening numbers; it never recomputes them. ECI state vectors are " +
      "accepted but not forwarded to the model.",
    params: [
      {
        name: "target",
        in: "body",
        type: "object",
        required: true,
        description: "ScreeningTarget: { noradId, name, epoch } strings + finite meanAltitudeKm, inclinationDeg, periodMinutes.",
      },
      { name: "windowStart", in: "body", type: "string", required: true, example: EX_TIME, description: "ISO window start from the screen." },
      { name: "windowEnd", in: "body", type: "string", required: true, example: "2024-01-02T12:00:00.000Z", description: "ISO window end from the screen." },
      { name: "candidatesScreened", in: "body", type: "number", required: true, example: "412", description: "Finite, ≥ 0." },
      {
        name: "assumptions",
        in: "body",
        type: "object",
        required: true,
        description:
          "ScreeningAssumptions: sigmaRicKm[3], hardBodyRadiusM, keepOutBoxKm { radial, inTrack, crossTrack }, coarseStepSeconds, windowHours, reportThresholdKm.",
      },
      {
        name: "closeApproaches",
        in: "body",
        type: "array",
        required: true,
        description:
          "ScreeningCloseApproach[] (≤ 500; may be empty). Each: noradId, name, objectClass, tca, missDistanceKm, relativeVelocityKmS, radialKm, inTrackKm, crossTrackKm, altitudeKm, probabilityOfCollision, insideKeepOutBox, severity.",
      },
    ],
    body: {
      target: EX_SCREEN_TARGET,
      windowStart: EX_TIME,
      windowEnd: "2024-01-02T12:00:00.000Z",
      candidatesScreened: 412,
      assumptions: EX_SCREEN_ASSUMPTIONS,
      closeApproaches: [EX_SCREEN_APPROACH],
    },
    response: {
      targetNoradId: "25544",
      text: "SCREENING SUMMARY\n…\nDISPOSITION: GREEN",
      disposition: "GREEN",
      generatedAt: EX_TIME,
    },
    cost: "claude",
    costEstimate: "~$0.01 / call (est.)",
    cache: "5 min per SHA-256 of the validated body (≤ 128 entries)",
    upstream: ["Anthropic Claude"],
    errors: [
      { status: 400, description: "Invalid JSON or a malformed field — { error } names it." },
      ERR_500("Claude call failed"),
    ],
  },

  /* ---------------- Fleet ---------------- */
  {
    id: "fleet",
    method: "GET",
    path: "/api/fleet",
    tag: "Fleet",
    summary: "Fleet intelligence brief",
    description:
      "Counts are computed server-side from the 2,000-object sample and the 25 soonest public " +
      "CDMs (heuristic thresholds: CRITICAL Pc ≥ 1e-3 or miss < 0.1 km; HIGH Pc ≥ 1e-4 or " +
      "miss < 1 km). ONE Claude call then adds shell statuses, the executive brief, risk trend, " +
      "top-3 threat reasoning and three recommended actions.",
    params: [],
    response: {
      generatedAt: EX_TIME,
      totalObjects: 2000,
      activeConjunctions: 25,
      highPriorityCount: 3,
      criticalCount: 0,
      shells: {
        leo: { count: 1815, status: "ELEVATED" },
        meo: { count: 42, status: "NOMINAL" },
        geo: { count: 143, status: "NOMINAL" },
      },
      executiveBrief: "LEO congestion remains the dominant risk driver…",
      riskTrend: "STABLE",
      topThreats: [{ name: "STARLINK-1234 ↔ FENGYUN 1C DEB", reasoning: "412 m miss at 1e-5-class Pc…", severity: "HIGH" }],
      recommendedActions: ["Starlink operations: confirm autonomous avoidance for the 44935 conjunction…"],
    },
    cost: "claude",
    costEstimate: "~$0.012 / cache refresh (est.)",
    cache: "2 min (single key) — matches the dashboard's 120 s poll",
    upstream: ["Space-Track.org gp", "Space-Track.org cdm_public", "Anthropic Claude"],
    errors: [
      { status: 502, description: "Claude returned an unparseable brief — { error, detail }." },
      ERR_500("Space-Track or Claude call failed"),
    ],
  },

  /* ---------------- ISS ---------------- */
  {
    id: "iss",
    method: "GET",
    path: "/api/iss",
    tag: "ISS",
    summary: "ISS element set + public CDMs involving NORAD 25544",
    description:
      "Latest ISS gp element set plus any public CDMs naming 25544, filtered from the 100 " +
      "soonest-TCA messages catalogue-wide (an ISS CDM further out than that window will not " +
      "appear). An empty `cdms` array is a valid NOMINAL state. HTTP 200 when at least one " +
      "source answered — per-source failures are reported in `errors`. The dashboard derives " +
      "ground track, JSC passes and RED/YELLOW grading (Pc ≥ 1e-4 / 1e-5) client-side.",
    params: [],
    response: { tle: EX_ISS_TLE, cdms: [], fetchedAt: EX_TIME, errors: {} },
    cost: "deterministic",
    costEstimate: "$0 — no Claude call",
    cache: "5 min (full success), 60 s (one source failed), 503 never cached",
    upstream: ["Space-Track.org gp", "Space-Track.org cdm_public"],
    errors: [
      { status: 503, description: "BOTH Space-Track sources failed — { error, detail }." },
      ERR_500("Unexpected server error"),
    ],
  },

  /* ---------------- Launch ---------------- */
  {
    id: "cola",
    method: "GET",
    path: "/api/cola",
    tag: "Launch",
    summary: "Launch collision-avoidance (COLA) window screen",
    description:
      "For every liftoff minute in the window, a simplified ascent model inserts the vehicle " +
      "into the target orbit at T+9 min, 20° downrange in the plane through the pad, coasts " +
      "it two-body for 20 min and screens it at 30 s steps against the catalog sample " +
      "(±50 km altitude prefilter). Each minute is NO-GO (< 5 km), CAUTION (< 25 km) or GO; " +
      "`summary.nextClearWindow` is the first run of consecutive GO minutes. Every model " +
      "constant is returned in `assumptions`. 400 when the orbit's inclination is below the " +
      "site latitude (no direct-ascent plane). Simplified model — not a range-safety COLA " +
      "product. The compute budget sets `truncated` when it trips.",
    params: [
      {
        name: "site",
        in: "query",
        type: "string",
        required: false,
        enum: COLA_SITE_IDS,
        default: "slc-40",
        example: "slc-40",
        description: `Launch site: ${LAUNCH_SITES.map((site) => site.label).join("; ")}.`,
      },
      {
        name: "orbit",
        in: "query",
        type: "string",
        required: false,
        enum: COLA_ORBIT_IDS,
        default: "starlink-550",
        example: "starlink-550",
        description: `Target orbit: ${TARGET_ORBITS.map((orbit) => orbit.label).join("; ")}.`,
      },
      {
        name: "minutes",
        in: "query",
        type: "integer",
        required: false,
        enum: COLA_MINUTES,
        default: "120",
        example: "120",
        description: "Launch-window length (minutes), one liftoff time per minute.",
      },
      {
        name: "start",
        in: "query",
        type: "string",
        required: false,
        maxLength: 64,
        format: "date-time",
        description:
          "Window start as an ISO-8601 date-time (YYYY-MM-DDTHH:MM[:SS]Z; no offset means UTC) within " +
          "±7 days of the request; rounded down to the minute. Defaults to now.",
      },
    ],
    query: { site: "slc-40", orbit: "starlink-550", minutes: "120" },
    response: {
      site: EX_COLA_SITE,
      orbit: EX_COLA_ORBIT,
      windowStart: EX_TIME,
      windowEnd: "2024-01-01T14:00:00.000Z",
      stepMinutes: 1,
      minutes: [
        {
          launchTime: EX_TIME,
          status: "GO",
          minMissKm: 41.7,
          objectName: "STARLINK-3121",
          noradId: "53122",
          tca: "2024-01-01T12:21:30.000Z",
        },
      ],
      candidatesScreened: 640,
      sampleSize: 2000,
      propagations: 183360, // (119·2 + 41 grid slots) × 640 candidates + 120 × 40 vehicle steps
      computeMs: 912,
      truncated: false,
      summary: { go: 117, caution: 3, noGo: 0, nextClearWindow: { start: EX_TIME, minutes: 37 } },
      assumptions: colaAssumptions(),
    },
    cost: "deterministic",
    costEstimate: "$0 — two-body propagation",
    cache: "5 min per site | orbit | minutes | start minute (≤ 64 entries)",
    upstream: ["Space-Track.org gp"],
    errors: [
      {
        status: 400,
        description:
          "site / orbit / minutes not in the allowed sets, bad start, or an unreachable site-orbit pair — { error }.",
      },
      ERR_500("Space-Track fetch or screening failed"),
    ],
  },

  /* ---------------- Space weather ---------------- */
  {
    id: "spaceweather",
    method: "GET",
    path: "/api/spaceweather",
    tag: "Space weather",
    summary: "Planetary Kp, F10.7 solar flux and LEO drag regime",
    description:
      "Two public NOAA SWPC feeds (planetary K-index and F10.7 cm radio flux); each parser " +
      "picks the NEWEST time tag. Derives the NOAA G-scale from Kp and a heuristic LEO " +
      "atmospheric-drag regime (LOW | MODERATE | ELEVATED | HIGH | UNKNOWN). HTTP 200 when " +
      "at least one feed parsed — the other feed's failure is in `errors`.",
    params: [],
    response: {
      fetchedAt: EX_TIME,
      kp: { value: 2.33, timeTag: "2024-01-01 09:00:00.000" },
      f107: { value: 142, timeTag: "2024-01-01T20:00:00" },
      gScale: "G0",
      dragRegime: "MODERATE",
      errors: {},
    },
    cost: "deterministic",
    costEstimate: "$0 — no Claude call, no credentials",
    cache: "15 min (both feeds), 2 min (one feed failed), 503 never cached",
    upstream: ["NOAA SWPC"],
    errors: [
      { status: 503, description: "BOTH SWPC feeds failed — { error, detail }." },
      ERR_500("Unexpected server error"),
    ],
  },

  /* ---------------- Ops ---------------- */
  {
    id: "health",
    method: "GET",
    path: "/api/health",
    tag: "Ops",
    summary: "Subsystem health + live Space-Track request budget",
    description:
      "Times one uncached limit-1 Space-Track gp query (ONLINE < 4 s, DEGRADED ≥ 4 s, OFFLINE " +
      "on error/timeout), reports whether an Anthropic key is configured (NO API call is " +
      "made), the serving region and instance uptime. `spaceTrackBudget` is recomputed on " +
      "every response, even when the probe is cached. Never returns 500.",
    params: [],
    response: {
      checkedAt: EX_TIME,
      region: "iad1",
      uptimeSeconds: 812,
      spaceTrack: { status: "ONLINE", latencyMs: 640, newestEpoch: "2024-01-01T11:58:02.000000" },
      anthropic: { status: "READY" },
      spaceTrackCredentials: true,
      spaceTrackBudget: {
        requestsLastHour: 41,
        requestsLastMinute: 2,
        hourlyLimit: 300,
        perMinuteLimit: 30,
        lastLoginAt: "2024-01-01T11:31:09.000Z",
        sessionCookieAgeSeconds: 1731,
        sharedCacheEntries: 2,
        sharedCacheHits: 57,
        sharedCacheMisses: 6,
      },
    },
    cost: "deterministic",
    costEstimate: "$0 — key presence check only",
    cache: "Probe 5 min (single key); budget counters live on every response",
    upstream: ["Space-Track.org gp (probe)"],
    errors: [],
  },
  {
    id: "openapi",
    method: "GET",
    path: "/api/openapi",
    tag: "Ops",
    summary: "This API as an OpenAPI 3.1 document",
    description:
      "Machine-readable description of every route on this page, generated from the same " +
      "endpoint list that renders /docs. Import it into Postman, Insomnia or an OpenAPI " +
      "code generator.",
    params: [],
    response: {
      openapi: "3.1.0",
      info: { title: "SpaceDebris API", version: API_VERSION },
      paths: { "/api/debris": { get: { operationId: "getDebris" } } },
    },
    cost: "deterministic",
    costEstimate: "$0 — static document",
    cache: "Cache-Control: public, max-age=300",
    upstream: [],
    errors: [],
  },
];

/** Flat endpoint list rendered by /docs (one entry per card). */
export const API_ENDPOINTS: ReadonlyArray<ApiEndpoint> = ENDPOINT_DEFS.map(toEndpoint);

export interface ApiCostCounts {
  /** Documented operations (debris counts twice: list + search). */
  total: number;
  deterministic: number;
  claude: number;
}

/** Cost split of an endpoint list — prose on /docs and in OpenAPI is built from it. */
export function costCounts(endpoints: ReadonlyArray<ApiEndpoint>): ApiCostCounts {
  const claude = endpoints.filter((ep) => ep.cost === "claude").length;
  return { total: endpoints.length, deterministic: endpoints.length - claude, claude };
}

export const API_COST_COUNTS: ApiCostCounts = costCounts(API_ENDPOINTS);

/** What "deterministic" means here — shared by OpenAPI info and /docs. */
export function costSummary(counts: ApiCostCounts): string {
  return (
    `${counts.deterministic} of the ${counts.total} operations are deterministic and make no AI call. ` +
    "Most of them pass public data through: /api/debris and /api/iss relay Space-Track.org element " +
    "sets and CDMs, /api/spaceweather relays NOAA SWPC indices (deriving the G-scale and a drag " +
    "regime), and /api/health and /api/openapi report subsystem status and the OpenAPI " +
    "document. Two run physics server-side: /api/screen (SGP4 conjunction screening with a " +
    "2-D probability of collision) and /api/cola (two-body ascent screened against the " +
    "SGP4-propagated catalog sample). The other " +
    `${counts.claude} operations are Claude-backed and spend the project's own Anthropic credits.`
  );
}

/* ------------------------------------------------------------
   OpenAPI 3.1 builder — derived from API_ENDPOINTS
   ------------------------------------------------------------ */

const TAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Catalog: "Space-Track gp element sets (public TLE catalog sample).",
  "Risk & maneuvers": "Claude-backed risk scoring and maneuver planning.",
  Conjunctions: "Public CDMs, deterministic SGP4 screening and Claude-written assessments.",
  Fleet: "Aggregate fleet intelligence brief.",
  ISS: "International Space Station element set and public CDMs.",
  Launch: "Launch collision-avoidance window screening.",
  "Space weather": "NOAA SWPC geomagnetic and solar-flux indices.",
  Ops: "Health, request budget and this document.",
};

/** "/api/space-weather" → "SpaceWeather" (used for operationId). */
function pascalFromPath(path: string): string {
  return path
    .replace(/^\/api\/?/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function enumValues(param: ApiParam): Array<string | number> | undefined {
  if (!param.enum) return undefined;
  const numeric = param.type === "integer" || param.type === "number";
  return param.enum.map((v) => (numeric ? Number(v) : v));
}

function typedValue(param: ApiParam, raw: string | undefined): string | number | undefined {
  if (raw === undefined) return undefined;
  if (param.type === "integer" || param.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

function paramSchema(param: ApiParam): JsonSchema {
  const schema: JsonSchema = { type: param.type };
  const values = enumValues(param);
  if (values) schema.enum = values;
  const def = typedValue(param, param.default);
  if (def !== undefined) schema.default = def;
  if (param.maxLength !== undefined) schema.maxLength = param.maxLength;
  if (param.format !== undefined) schema.format = param.format;
  return schema;
}

function parseExample(json: string | undefined): unknown {
  if (json === undefined) return undefined;
  const value: unknown = JSON.parse(json);
  return value;
}

const RATE_LIMIT_HEADERS: Record<string, OpenApiRef> = {
  "X-RateLimit-Limit": { $ref: "#/components/headers/X-RateLimit-Limit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/X-RateLimit-Remaining" },
  "X-RateLimit-Tier": { $ref: "#/components/headers/X-RateLimit-Tier" },
};

function rateLimitSentence(rl: ApiRateLimit): string {
  const tier =
    rl.tier === "expensive"
      ? `expensive tier — burst ${rl.burst}, ${rl.perMinute} requests/min per IP, on top of the general bucket`
      : `general tier — burst ${rl.burst}, ${rl.perMinute} requests/min per IP`;
  return rl.note ? `${tier}. ${rl.note}` : `${tier}.`;
}

/** Merge every endpoint that shares path + method into ONE OpenAPI operation. */
function buildOperation(group: ReadonlyArray<ApiEndpoint>): OpenApiOperation {
  const first = group[0];
  const multi = group.length > 1;

  // Query parameters: union by name; required only if required in every mode.
  const queryParams = new Map<string, OpenApiParameter>();
  for (const ep of group) {
    for (const p of ep.params) {
      if (p.in !== "query") continue;
      const requiredEverywhere = group.every((g) =>
        g.params.some((q) => q.in === "query" && q.name === p.name && q.required)
      );
      if (queryParams.has(p.name)) continue;
      const param: OpenApiParameter = {
        name: p.name,
        in: "query",
        required: requiredEverywhere,
        description: multi ? `${ep.summary}: ${p.description}` : p.description,
        schema: paramSchema(p),
      };
      const example = typedValue(p, p.example);
      if (example !== undefined) param.example = example;
      queryParams.set(p.name, param);
    }
  }

  // Body parameters → one JSON object schema.
  const bodyParams = first.params.filter((p) => p.in === "body");
  let requestBody: OpenApiOperation["requestBody"];
  if (bodyParams.length > 0) {
    const properties: Record<string, JsonSchema> = {};
    for (const p of bodyParams) {
      const prop = paramSchema(p);
      prop.description = p.description;
      const example = typedValue(p, p.example);
      if (example !== undefined) prop.example = example;
      properties[p.name] = prop;
    }
    requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: bodyParams.filter((p) => p.required).map((p) => p.name),
            properties,
          },
          example: parseExample(first.requestExample),
        },
      },
    };
  }

  // 200 response: one example per mode.
  const okMedia: OpenApiMediaType = { schema: { type: "object" } };
  if (multi) {
    okMedia.examples = {};
    for (const ep of group) {
      okMedia.examples[ep.id] = { summary: ep.summary, value: parseExample(ep.responseExample) };
    }
  } else {
    okMedia.example = parseExample(first.responseExample);
  }

  const responses: Record<string, OpenApiResponse | OpenApiRef> = {
    "200": {
      description: "Success.",
      headers: RATE_LIMIT_HEADERS,
      content: { "application/json": okMedia },
    },
  };
  for (const ep of group) {
    for (const err of ep.errors) {
      const key = String(err.status);
      if (responses[key]) continue;
      responses[key] = {
        description: err.description,
        headers: RATE_LIMIT_HEADERS,
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      };
    }
  }
  if (first.method === "POST") {
    responses["403"] = { $ref: "#/components/responses/CrossOriginForbidden" };
  }
  responses["429"] = { $ref: "#/components/responses/TooManyRequests" };

  const description = group
    .map((ep) => {
      const body =
        `${ep.description}\n\n` +
        `**Cost:** ${ep.cost === "claude" ? "Claude (Anthropic tokens)" : "deterministic"} — ${ep.costEstimate}. ` +
        `**Cache:** ${ep.cache}. ` +
        `**Upstream:** ${ep.upstream.length > 0 ? ep.upstream.join(", ") : "none"}. ` +
        `**Rate limit:** ${rateLimitSentence(ep.rateLimit)}`;
      return multi ? `### ${ep.summary}\n\n${body}` : body;
    })
    .join("\n\n");

  const upstream = Array.from(new Set(group.flatMap((ep) => ep.upstream)));
  const anyClaude = group.some((ep) => ep.cost === "claude");

  const op: OpenApiOperation = {
    operationId: `${first.method.toLowerCase()}${pascalFromPath(first.path)}`,
    summary: group.map((ep) => ep.summary).join(" / "),
    description,
    tags: [first.tag],
    responses,
    "x-cost": anyClaude ? "claude" : "deterministic",
    "x-cost-estimate": Array.from(new Set(group.map((ep) => ep.costEstimate))).join("; "),
    "x-cache": Array.from(new Set(group.map((ep) => ep.cache))).join("; "),
    "x-upstream": upstream,
    "x-rate-limit": group.map((ep) => ({ endpoint: ep.id, ...ep.rateLimit })),
  };
  if (queryParams.size > 0) op.parameters = Array.from(queryParams.values());
  if (requestBody) op.requestBody = requestBody;
  return op;
}

/** Build the OpenAPI 3.1 document from an endpoint list (exported for tests). */
export function buildOpenApiSpec(endpoints: ReadonlyArray<ApiEndpoint>): OpenApiDocument {
  // Group by path + method, preserving first-seen order.
  const groups = new Map<string, ApiEndpoint[]>();
  for (const ep of endpoints) {
    const key = `${ep.method} ${ep.path}`;
    const list = groups.get(key);
    if (list) list.push(ep);
    else groups.set(key, [ep]);
  }

  const paths: OpenApiDocument["paths"] = {};
  groups.forEach((group) => {
    const first = group[0];
    const item = paths[first.path] ?? {};
    if (first.method === "GET") item.get = buildOperation(group);
    else item.post = buildOperation(group);
    paths[first.path] = item;
  });

  const tagsInOrder = Array.from(new Set(endpoints.map((ep) => ep.tag)));
  const counts = costCounts(endpoints);

  return {
    openapi: "3.1.0",
    info: {
      title: "SpaceDebris API",
      version: API_VERSION,
      summary: "Public space-debris data, SGP4 conjunction screening and AI assessments.",
      description:
        "Public REST API behind the SpaceDebris dashboard. No operation needs credentials.\n\n" +
        `**Cost.** ${costSummary(counts)} Each operation says which it is in x-cost ` +
        "(deterministic | claude): please do not script the Claude-backed ones.\n\n" +
        `**Rate limit.** ${RATE_LIMIT_POLICY} Each operation's tier is in x-rate-limit.\n\n` +
        `**CORS.** ${CORS_POLICY}\n\n` +
        `**Scope.** ${API_DISCLAIMER}\n\n` +
        "Response examples are illustrative and abbreviated. Space-Track fields are passed " +
        "through as strings, exactly as Space-Track publishes them. For local development, " +
        "`next dev` serves the same paths at port 3000.",
      license: { name: "All rights reserved", url: API_REPOSITORY_URL },
    },
    servers: [{ url: API_BASE_URL, description: "Production (Vercel)" }],
    security: [],
    tags: tagsInOrder.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] ?? name })),
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", description: "Human-readable error." },
            detail: { type: "string", description: "Underlying cause (5xx only)." },
          },
        },
        RateLimitError: {
          type: "object",
          required: ["error", "retryAfterSeconds"],
          properties: {
            error: { type: "string", example: "Rate limit exceeded" },
            retryAfterSeconds: { type: "integer", minimum: 1 },
          },
        },
      },
      headers: {
        "X-RateLimit-Limit": {
          description:
            `Capacity of the bucket that applies: ${API_RATE_LIMIT.capacity} (general) or ` +
            `${API_EXPENSIVE_RATE_LIMIT.capacity} (expensive tier). On a 429 it is the bucket that denied the request.`,
          schema: { type: "integer" },
        },
        "X-RateLimit-Remaining": {
          description: "Whole tokens left in that bucket for this client after the request.",
          schema: { type: "integer" },
        },
        "X-RateLimit-Tier": {
          description: "Tier of this request: general (general bucket only) or expensive (both buckets).",
          schema: { type: "string", enum: ["general", "expensive"] },
        },
        "Retry-After": {
          description: "Seconds until one token is available again.",
          schema: { type: "integer" },
        },
      },
      responses: {
        TooManyRequests: {
          description:
            `Rate limit exceeded (general: ${API_RATE_LIMIT_PER_MINUTE} requests/min per IP, burst ` +
            `${API_RATE_LIMIT.capacity}; expensive tier: ${API_EXPENSIVE_RATE_LIMIT_PER_MINUTE} requests/min, ` +
            `burst ${API_EXPENSIVE_RATE_LIMIT.capacity}).`,
          headers: {
            "Retry-After": { $ref: "#/components/headers/Retry-After" },
            ...RATE_LIMIT_HEADERS,
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RateLimitError" },
              example: { error: "Rate limit exceeded", retryAfterSeconds: 1 },
            },
          },
        },
        CrossOriginForbidden: {
          description:
            "A browser on another origin sent this POST (its Origin header names another host). " +
            "Server-side callers that send no Origin header are unaffected.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: { error: "Cross-origin requests may only use GET." },
            },
          },
        },
      },
    },
  };
}

/** The OpenAPI 3.1 document served by GET /api/openapi. */
export const OPENAPI_SPEC: OpenApiDocument = buildOpenApiSpec(API_ENDPOINTS);
