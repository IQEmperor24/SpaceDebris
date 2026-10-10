import { NextResponse } from "next/server";
import { getAnthropic, CLAUDE_MODEL, DEFAULT_TEMPERATURE } from "@/lib/anthropic";
import {
  SCREENING_ASSESSMENT_PROMPT,
  buildScreeningAssessmentUserPrompt,
  type ScreeningAssessment,
  type ScreeningAssessmentRequest,
  type ScreeningAssumptions,
  type ScreeningCloseApproach,
  type ScreeningDisposition,
  type ScreeningObjectClass,
  type ScreeningTarget,
  type ThreatLevel,
} from "@/lib/prompts";

/* ============================================================
   POST /api/assess

   Body (JSON): ScreeningAssessmentRequest
     {
       target: { noradId, name, meanAltitudeKm, inclinationDeg,
                 periodMinutes, epoch },
       windowStart, windowEnd, candidatesScreened,
       assumptions: { sigmaRicKm[3], hardBodyRadiusM,
                      keepOutBoxKm{radial,inTrack,crossTrack},
                      coarseStepSeconds, windowHours },
       closeApproaches: ScreeningCloseApproach[]
     }

   Flow
   1. Validate the body shape strictly (types, finite numbers,
      enum fields) — the client forwards a subset of the
      ScreeningResult it received from GET /api/screen.
   2. Cap closeApproaches to the 8 LOWEST miss distances before
      prompting (keeps the prompt small; the memo covers ≤ 3).
   3. 5-minute in-memory cache keyed on the full event identity:
        target.noradId | windowStart | <noradId@tca,...>
      so two different screening runs never share a memo while a
      re-click on the same run costs no tokens.
   4. ONE Claude call (prompt from lib/prompts.ts — never inline)
      -> CARA-style plain-text memo ending with a DISPOSITION line.
   5. Regex-extract GREEN / YELLOW / RED. Missing or unparseable
      -> YELLOW (never understate a conjunction picture).
   6. Return ScreeningAssessment { targetNoradId, text,
      disposition, generatedAt }.

   Claude INTERPRETS the deterministic screening numbers; it never
   recomputes them. Structure mirrors app/api/cascade/route.ts.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ASSESS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ASSESS_MAX_TOKENS = 1500; // ~350-word memo + disposition line + slack
const MAX_EVENTS_IN_PROMPT = 8;
const MAX_INCOMING_EVENTS = 500; // sanity cap on the array we validate
const MAX_STRING_LENGTH = 256;
const MAX_CACHE_ENTRIES = 128;

interface CacheEntry {
  data: ScreeningAssessment;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): ScreeningAssessment | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCached(key: string, data: ScreeningAssessment): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    const expired: string[] = [];
    cache.forEach((v, k) => {
      if (v.expires <= now) expired.push(k);
    });
    for (const k of expired) cache.delete(k);
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }
  cache.set(key, { data, expires: Date.now() + ASSESS_CACHE_TTL_MS });
}

/** Composite cache key — see header comment for rationale. */
function buildCacheKey(req: ScreeningAssessmentRequest): string {
  return (
    req.target.noradId +
    "|" +
    req.windowStart +
    "|" +
    req.closeApproaches.map((e) => e.noradId + "@" + e.tca).join(",")
  );
}

/**
 * Extract the disposition from the model's trailing line. Tolerant
 * of brackets / whitespace / punctuation. Defaults to YELLOW when
 * missing — safer than GREEN, which would understate the picture.
 */
function extractDisposition(text: string): ScreeningDisposition {
  const match = text.match(/DISPOSITION\s*:\s*\[?\s*(GREEN|YELLOW|RED)/i);
  if (!match) return "YELLOW";
  return match[1].toUpperCase() as ScreeningDisposition;
}

/* ------------------------------------------------------------
   Body validation
   ------------------------------------------------------------ */

const OBJECT_CLASSES: ReadonlySet<string> = new Set<ScreeningObjectClass>([
  "DEBRIS",
  "ROCKET BODY",
  "PAYLOAD",
  "UNKNOWN",
]);
const SEVERITIES: ReadonlySet<string> = new Set<ThreatLevel>([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_STRING_LENGTH;
}

function parseTarget(v: unknown): ScreeningTarget | null {
  if (!isRecord(v)) return null;
  if (!isNonEmptyString(v.noradId) || !isNonEmptyString(v.name)) return null;
  if (
    !isFiniteNumber(v.meanAltitudeKm) ||
    !isFiniteNumber(v.inclinationDeg) ||
    !isFiniteNumber(v.periodMinutes)
  ) {
    return null;
  }
  if (!isNonEmptyString(v.epoch)) return null;
  return {
    noradId: v.noradId.trim(),
    name: v.name.trim(),
    meanAltitudeKm: v.meanAltitudeKm,
    inclinationDeg: v.inclinationDeg,
    periodMinutes: v.periodMinutes,
    epoch: v.epoch.trim(),
  };
}

function parseAssumptions(v: unknown): ScreeningAssumptions | null {
  if (!isRecord(v)) return null;
  const sigma = v.sigmaRicKm;
  if (!Array.isArray(sigma) || sigma.length !== 3 || !sigma.every(isFiniteNumber)) {
    return null;
  }
  if (!isFiniteNumber(v.hardBodyRadiusM)) return null;
  const box = v.keepOutBoxKm;
  if (
    !isRecord(box) ||
    !isFiniteNumber(box.radial) ||
    !isFiniteNumber(box.inTrack) ||
    !isFiniteNumber(box.crossTrack)
  ) {
    return null;
  }
  if (!isFiniteNumber(v.coarseStepSeconds) || !isFiniteNumber(v.windowHours)) {
    return null;
  }
  return {
    sigmaRicKm: [sigma[0], sigma[1], sigma[2]],
    hardBodyRadiusM: v.hardBodyRadiusM,
    keepOutBoxKm: {
      radial: box.radial,
      inTrack: box.inTrack,
      crossTrack: box.crossTrack,
    },
    coarseStepSeconds: v.coarseStepSeconds,
    windowHours: v.windowHours,
  };
}

function parseApproach(v: unknown): ScreeningCloseApproach | null {
  if (!isRecord(v)) return null;
  if (!isNonEmptyString(v.noradId) || !isNonEmptyString(v.name)) return null;
  if (typeof v.objectClass !== "string" || !OBJECT_CLASSES.has(v.objectClass)) {
    return null;
  }
  if (!isNonEmptyString(v.tca)) return null;
  const numericKeys = [
    "missDistanceKm",
    "relativeVelocityKmS",
    "radialKm",
    "inTrackKm",
    "crossTrackKm",
    "altitudeKm",
    "probabilityOfCollision",
  ] as const;
  for (const key of numericKeys) {
    if (!isFiniteNumber(v[key])) return null;
  }
  if (typeof v.insideKeepOutBox !== "boolean") return null;
  if (typeof v.severity !== "string" || !SEVERITIES.has(v.severity)) return null;
  return {
    noradId: v.noradId.trim(),
    name: v.name.trim(),
    objectClass: v.objectClass as ScreeningObjectClass,
    tca: v.tca.trim(),
    missDistanceKm: v.missDistanceKm as number,
    relativeVelocityKmS: v.relativeVelocityKmS as number,
    radialKm: v.radialKm as number,
    inTrackKm: v.inTrackKm as number,
    crossTrackKm: v.crossTrackKm as number,
    altitudeKm: v.altitudeKm as number,
    probabilityOfCollision: v.probabilityOfCollision as number,
    insideKeepOutBox: v.insideKeepOutBox,
    severity: v.severity as ThreatLevel,
  };
}

type Validation =
  | { ok: true; request: ScreeningAssessmentRequest }
  | { ok: false; error: string };

/** Strict validation of the POST body; caps events to the 8 lowest misses. */
function validateBody(body: unknown): Validation {
  if (!isRecord(body)) {
    return { ok: false, error: "Body must be a JSON object (ScreeningAssessmentRequest)." };
  }

  const target = parseTarget(body.target);
  if (!target) {
    return {
      ok: false,
      error:
        "Invalid target: expected { noradId, name, epoch } strings and finite meanAltitudeKm, inclinationDeg, periodMinutes.",
    };
  }

  if (!isNonEmptyString(body.windowStart) || !isNonEmptyString(body.windowEnd)) {
    return { ok: false, error: "windowStart and windowEnd must be ISO strings." };
  }
  if (!isFiniteNumber(body.candidatesScreened) || body.candidatesScreened < 0) {
    return { ok: false, error: "candidatesScreened must be a finite non-negative number." };
  }

  const assumptions = parseAssumptions(body.assumptions);
  if (!assumptions) {
    return {
      ok: false,
      error:
        "Invalid assumptions: expected sigmaRicKm[3], hardBodyRadiusM, keepOutBoxKm{radial,inTrack,crossTrack}, coarseStepSeconds, windowHours (all finite numbers).",
    };
  }

  if (!Array.isArray(body.closeApproaches)) {
    return { ok: false, error: "closeApproaches must be an array." };
  }
  if (body.closeApproaches.length > MAX_INCOMING_EVENTS) {
    return {
      ok: false,
      error: `closeApproaches may hold at most ${MAX_INCOMING_EVENTS} events.`,
    };
  }
  const approaches: ScreeningCloseApproach[] = [];
  for (let i = 0; i < body.closeApproaches.length; i++) {
    const parsed = parseApproach(body.closeApproaches[i]);
    if (!parsed) {
      return { ok: false, error: `closeApproaches[${i}] is malformed.` };
    }
    approaches.push(parsed);
  }
  approaches.sort((a, b) => a.missDistanceKm - b.missDistanceKm);

  return {
    ok: true,
    request: {
      target,
      windowStart: body.windowStart.trim(),
      windowEnd: body.windowEnd.trim(),
      candidatesScreened: body.candidatesScreened,
      assumptions,
      closeApproaches: approaches.slice(0, MAX_EVENTS_IN_PROMPT),
    },
  };
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

export async function POST(req: Request): Promise<NextResponse> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validation = validateBody(rawBody);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const request = validation.request;

  const cacheKey = buildCacheKey(request);
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: ASSESS_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      system: SCREENING_ASSESSMENT_PROMPT,
      messages: [
        { role: "user", content: buildScreeningAssessmentUserPrompt(request) },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const rawText =
      textBlock && textBlock.type === "text" ? textBlock.text : "";

    if (!rawText.trim()) {
      throw new Error("Empty model response.");
    }

    const result: ScreeningAssessment = {
      targetNoradId: request.target.noradId,
      text: rawText.trim(),
      disposition: extractDisposition(rawText),
      generatedAt: new Date().toISOString(),
    };

    setCached(cacheKey, result);
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/assess] error:", detail);
    return NextResponse.json(
      { error: "Failed to generate conjunction assessment.", detail },
      { status: 500 }
    );
  }
}
