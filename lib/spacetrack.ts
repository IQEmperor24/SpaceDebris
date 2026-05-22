/* ============================================================
   SpaceDebris — Space-Track.org API client

   Handles:
   - Session-cookie authentication (POST /ajaxauth/login).
   - Cookie caching for 50 minutes (CONTEXT.md line 194).
   - Automatic re-login + single retry on 401 (Gotcha #1).
   - Typed fetches for TLEs (orbital map + risk scorer) and
     CDM conjunctions (alert feed).

   Credentials come from env only (Workflow Rule #9):
     SPACETRACK_USERNAME, SPACETRACK_PASSWORD

   IMPORTANT: routes that import this MUST run on the Node.js
   runtime (export const runtime = "nodejs"), not Edge — this
   relies on cookies and longer-lived requests.
   ============================================================ */

const BASE_URL = "https://www.space-track.org";
const LOGIN_URL = `${BASE_URL}/ajaxauth/login`;
const QUERY_BASE = `${BASE_URL}/basicspacedata/query`;

/** Session cookie is valid for ~1 hour; refresh after 50 minutes. */
const COOKIE_TTL_MS = 50 * 60 * 1000;

/* ------------------------------------------------------------
   Response shapes — Space-Track returns every field as a STRING
   in JSON, so these are all typed as string (Workflow Rule #10).
   ------------------------------------------------------------ */

/** A row from the `gp` class (General Perturbations — current TLE source). */
export interface SpaceTrackTLE {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  NORAD_CAT_ID: string;
  EPOCH: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
  INCLINATION: string;
  RA_OF_ASC_NODE: string;
  ECCENTRICITY: string;
  ARG_OF_PERICENTER: string;
  MEAN_ANOMALY: string;
  MEAN_MOTION: string;
  SEMIMAJOR_AXIS: string;
  PERIOD: string;
  APOAPSIS: string;
  PERIAPSIS: string;
}

/** A row from the `cdm_public` class (Conjunction Data Message). */
export interface SpaceTrackCDM {
  CDM_ID: string;
  CREATED: string;
  TCA: string;
  MIN_RNG: string;
  PC: string;
  SAT_1_ID: string;
  SAT_1_NAME: string;
  SAT_2_ID: string;
  SAT_2_NAME: string;
}

/* ------------------------------------------------------------
   Session cookie cache (module-scoped) + re-login on 401.
   ------------------------------------------------------------ */

let sessionCookie: string | null = null;
let cookieFetchedAt = 0;

/** Read + validate credentials from the environment. */
function getCredentials(): { identity: string; password: string } {
  const identity = process.env.SPACETRACK_USERNAME;
  const password = process.env.SPACETRACK_PASSWORD;
  if (!identity || !password) {
    throw new Error(
      "SPACETRACK_USERNAME / SPACETRACK_PASSWORD are not set. Add them to .env.local (local) and to the Vercel dashboard (production)."
    );
  }
  return { identity, password };
}

/**
 * Log in to Space-Track and cache the session cookie.
 * Parses the cookie per Gotcha #1: setCookie.split(";")[0].
 */
async function login(): Promise<string> {
  const { identity, password } = getCredentials();

  const body = new URLSearchParams({ identity, password }).toString();

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `Space-Track login failed: HTTP ${res.status} ${res.statusText}`
    );
  }

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(
      "Space-Track login succeeded but no session cookie was returned. Check that the account is approved and credentials are correct."
    );
  }

  // "chocolatechip=...; Path=/; ..." -> keep only "chocolatechip=..."
  sessionCookie = setCookie.split(";")[0];
  cookieFetchedAt = Date.now();
  return sessionCookie;
}

/** Return a valid session cookie, logging in if missing/expired. */
async function getSessionCookie(forceRefresh = false): Promise<string> {
  const expired = Date.now() - cookieFetchedAt > COOKIE_TTL_MS;
  if (forceRefresh || !sessionCookie || expired) {
    return login();
  }
  return sessionCookie;
}

/**
 * GET a Space-Track query and parse JSON. On 401, null the cookie,
 * re-login, and retry exactly once (Gotcha #1).
 */
async function spaceTrackGet<T>(queryPath: string): Promise<T> {
  const url = `${QUERY_BASE}/${queryPath}`;

  const doRequest = async (cookie: string): Promise<Response> =>
    fetch(url, {
      method: "GET",
      headers: { Cookie: cookie },
      cache: "no-store",
    });

  let cookie = await getSessionCookie();
  let res = await doRequest(cookie);

  // 401 -> session likely expired/invalid. Force re-login and retry once.
  if (res.status === 401) {
    sessionCookie = null;
    cookie = await getSessionCookie(true);
    res = await doRequest(cookie);
  }

  if (!res.ok) {
    // Print the FULL absolute URL (not just the relative path) so a
    // 404/401 shows exactly what was requested.
    throw new Error(
      `Space-Track query failed: HTTP ${res.status} ${res.statusText} — ${url}`
    );
  }

  return (await res.json()) as T;
}

/* ------------------------------------------------------------
   Public data fetchers.
   ------------------------------------------------------------ */

/**
 * Fetch a sample of the latest TLEs for the 3D orbital map.
 * Newest epoch first; capped by `limit`.
 */
export async function fetchTLEs(limit: number): Promise<SpaceTrackTLE[]> {
  const safeLimit = Math.max(1, Math.min(limit, 5000));
  // `gp` (General Perturbations) is Space-Track's current recommended
  // class — returns one latest element set per object, no ORDINAL needed.
  const path = `class/gp/orderby/EPOCH%20desc/limit/${safeLimit}/format/json`;
  return spaceTrackGet<SpaceTrackTLE[]>(path);
}

/**
 * Look up a single object for the risk scorer.
 * Numeric query -> NORAD_CAT_ID; otherwise wildcard name match (~~).
 * Returns null if nothing matches.
 */
export async function searchTLE(query: string): Promise<SpaceTrackTLE | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const isNoradId = /^\d+$/.test(trimmed);
  const predicate = isNoradId
    ? `NORAD_CAT_ID/${encodeURIComponent(trimmed)}`
    : `OBJECT_NAME/~~${encodeURIComponent(trimmed)}`;

  const path = `class/gp/${predicate}/orderby/EPOCH%20desc/limit/1/format/json`;
  const results = await spaceTrackGet<SpaceTrackTLE[]>(path);
  return results.length > 0 ? results[0] : null;
}

/**
 * Fetch upcoming conjunction events (CDMs) for the alert feed.
 * Future TCA only, soonest first; capped by `limit`.
 */
export async function fetchConjunctions(
  limit: number
): Promise<SpaceTrackCDM[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const path = `class/cdm_public/TCA/%3Enow/orderby/TCA%20asc/limit/${safeLimit}/format/json`;
  return spaceTrackGet<SpaceTrackCDM[]>(path);
}
