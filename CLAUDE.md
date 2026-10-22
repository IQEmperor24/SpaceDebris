# SpaceDebris — CLAUDE.md
# Holy Grail Context File for Claude Code (Opus)
# READ THIS ENTIRELY BEFORE RESPONDING TO ANY PROMPT
# Last updated: End of Session 6 — SpaceX-ops upgrade (7 more features)
# Phases 1, 2, 3 COMPLETE · Session 5 (7) LIVE on main · Session 6 (7) LIVE on main (squash-merged)

---

## OPERATOR NOTE — CRITICAL
Aayush is a Waterloo CS grad building SpaceDebris solo.
This is a POST-HACKATHON production build.
We are building potentially trillion-dollar space infrastructure.
Every decision matters.
As his AI pair programmer, you MUST:
- Be EXTREMELY verbose in every response
- Never assume he remembers something — restate context every time
- Call out potential mistakes BEFORE he makes them
- Never give partial files — always give the COMPLETE file, top to bottom
- Never say "rest of file stays the same"
- Double-check every file for typos, missing imports, broken references
- Remind him of the deploy sequence every single time he is about to deploy
- Flag any command that could break the build BEFORE he runs it
- For ALL debug prompts: "Only look at [FILE]. Do not read any other files."
- Never run terminal commands yourself — Aayush runs ALL commands
- After EVERY feature: npm run build must be clean before git push

---

## Project Vision
SpaceDebris — AI-powered real-time space debris collision risk dashboard.
Started as 24-hour Houston Hackathon build.
Now being developed into critical space infrastructure.
Total development cost so far: ~$24 USD across 4 sessions.

### The Pitch
"46,000 objects are tracked in Earth orbit. SpaceX performed 300,000
collision avoidance maneuvers in 2025 — a 50% increase over 2024.
One collision can trigger Kessler Syndrome — a chain reaction that
makes all orbits permanently unusable, killing GPS, internet, and
weather satellites forever. SpaceDebris is the AI infrastructure
layer that monitors, predicts, and prevents that."

### Market Opportunity
- SpaceX spends ~$300M/year on collision avoidance maneuvers
- Global satellite insurance market: $1B/year
- Space economy projected $1 trillion by 2040 (Goldman Sachs)
- FCC requires biannual safety reports from all operators
- No standardized AI tool exists for conjunction risk assessment

### Key Connection
NASA-connected judge at HackHCC Houston sent LinkedIn
connection request after seeing SpaceDebris demo.
LinkedIn message sent. Awaiting response.
When he responds — prepare NASA demo version immediately.

---

## Live Deployment
- URL: https://space-debris-two.vercel.app
- Vercel Authentication: DISABLED (fully public)
- GitHub: https://github.com/IQEmperor24/SpaceDebris.git
- Branch: main
- Auto-deploys on every git push origin main
- vercel --prod CLI NOT needed — push to GitHub = auto deploy
- ANTHROPIC_API_KEY: Aayush's OWN account (not aunt's)
- Anthropic credits remaining: ~$19.86

---

## Tech Stack
- Next.js 14.2.35 App Router (patched from 14.2.3 in Session 6: CVE-2025-29927 middleware bypass only affected self-hosted deploys, Vercel was never exposed)
- TypeScript (strict mode ON)
- Tailwind CSS
- Three.js (3D orbital visualization)
- satellite.js (SGP4 TLE propagation)
- Anthropic Claude API — model: claude-sonnet-4-6
- Space-Track.org API (live TLE + CDM data)
- Vercel (deployment, Hobby plan)

---

## Current Status — FULLY WORKING (Session 4)

### Core Features (Hackathon Sessions 1-3)
- App boots cleanly at localhost:3000
- npm run build — CLEAN, zero errors
- 3D Earth globe renders at 47-60 FPS
- ALL/LEO/MEO/GEO filter buttons working
- Object counter shows filtered/total (1,989/1,989)
- ~1,989 debris objects from Space-Track gp class
- Debris dots: distinct individual points (uSize 2.0)
- Deployed live at space-debris-two.vercel.app
- Vercel public access enabled
- vercel.json generated
- GitHub auto-deploy connected

### Phase 1 — Kessler Cascade Simulator ✅ COMPLETE
- SIMULATE CASCADE button on MEDIUM/HIGH/CRITICAL alerts
- Calls /api/cascade POST endpoint
- 5-section cascade simulation from Claude AI
- CASCADE STATUS badge: CONTAINED/WARNING/CRITICAL/CATASTROPHIC
- Cache keyed by composite key (cdmId+sat1Id+sat2Id+tca+miss+prob)
- Each conjunction gets unique simulation
- RE-RUN CASCADE SIMULATION button
- 5-minute Map cache

### Phase 2 — Maneuver Recommendation Engine ✅ COMPLETE
- GET MANEUVER PLAN button on MEDIUM/HIGH/CRITICAL risk scores
- Calls /api/maneuver POST endpoint
- 6-section maneuver plan from Claude AI
- Real Tsiolkovsky rocket equation for fuel estimates
- Isp 220s, 1000kg satellite mass assumption
- RECOMMENDATION badge: MONITOR/PREPARE/EXECUTE/EMERGENCY
- EMERGENCY badge pulses red
- Stale plan clears on new satellite search
- 2-minute Map cache
- analyze route now passes TLE data to frontend

### Phase 3 — Fleet Intelligence Dashboard ✅ COMPLETE
- New FleetDashboard component below existing 3 panels
- 4 stat cards: total objects, active conjunctions,
  high priority, critical (pulses if > 0)
- 3 orbital shell bars: LEO/MEO/GEO
  Status: NOMINAL/ELEVATED/CRITICAL
  LEO currently ELEVATED (1,815 objects)
- Top 3 threats with severity badges + AI reasoning
- Executive Brief — NASA Administrator level
- Risk trend: IMPROVING/STABLE/DETERIORATING
- 3 recommended actions (specific, WHO/WHAT/WHICH)
- 120s refresh loop + 1s countdown ticker
- 2-minute Map cache (single key "fleet")
- Concurrent Promise.all for TLE + conjunction fetch
- TREND indicator top right with color coding

### AI Risk Scorer ✅ WORKING
- All 5 chips working (ISS, HUBBLE, STARLINK-1234, 25544, NOAA 19)
- Returns real AI risk score with 3 bars
- Collision Probability / Debris Density / Orbital Stability

### Collision Alert Feed ✅ WORKING
- Real CDMs from Space-Track.org
- Claude summarizes in plain English
- Threat badges (LOW/MEDIUM/HIGH/CRITICAL)
- 60s auto-refresh countdown
- SIMULATE CASCADE button on MEDIUM/HIGH/CRITICAL

---

## Session 5 — NASA / JSC Upgrade ✅ COMPLETE (7 bolt-on features)
Context: HackHCC judges + HCC dean connected Aayush with NASA/JSC staff.
Goal: strengthen the proven product with REAL orbital mechanics
(deterministic SGP4 physics) next to the existing Claude features, using
JSC vocabulary correctly (TOPO, TCA, Pc, RIC, DAM/PDAM, CARA, 18 SDS).
Built in a Claude Code cloud session on branch feature/nasa-jsc-upgrade,
merged to main (commit 260229c) and LIVE at space-debris-two.vercel.app.

### Feature 1 — Live SGP4 Propagation + Time Warp (3D map) ✅
- components/OrbitalMap.tsx (only existing file edited)
- Debris dots now MOVE: every object re-propagated at simulated time,
  position buffer updated in place (DynamicDrawUsage), 4 Hz when warped
- Controls bottom-left: LIVE · 1× · 10× · 60× · 600× + SIM UTC clock
  with offset readout "(+2h 14m)" when not live
- Shaders, uSize 2.0, blending, OrbitControls, zone filter, tooltip,
  FPS/counter UNCHANGED. Colours/zones stay as classified at load.
- Demo move: click 600× — a LEO orbit sweeps in ~9 seconds

### Feature 2 — SGP4 Conjunction Screening Engine + AI CA Memo ✅
- lib/screening.ts (pure), app/api/screen/route.ts (GET),
  app/api/assess/route.ts (POST, Claude), components/ConjunctionScreener.tsx
- GET /api/screen?target=ISS&hours=24 — deterministic all-on-one screen:
  altitude-band prefilter → 60 s coarse SGP4 sweep → golden-section
  refinement of each local minimum → miss distance, relative velocity,
  RIC separation in the TARGET frame, probability of collision (2-D
  encounter-plane integral, assumed TLE-grade covariance σ RIC
  0.3 / 1.0 / 0.3 km per object, HBR 20 m), NASA ISS keep-out box test
  (±2 km R × ±25 km I × ±25 km C). Severity: CRITICAL Pc≥1e-4 or <1 km;
  HIGH Pc≥1e-5 or box penetration; MEDIUM <10 km; LOW.
- 0.5 µs per SGP4 call → a 24 h screen of the 2,000-object sample runs
  in ~1-2 s server-side. 20 s compute budget, truncated flag, 5-min cache.
- POST /api/assess — Claude writes a CARA-style 5-section CA memo with a
  GREEN/YELLOW/RED DISPOSITION line (prompt: SCREENING_ASSESSMENT_PROMPT
  in lib/prompts.ts). This is "Phase 5 lite" — predicting conjunctions
  from TLEs before a CDM is published.
- UI footnote states plainly: not an operational CDM.

### Feature 3 — ISS TOPO Console ✅
- lib/iss.ts, app/api/iss/route.ts, components/IssConsole.tsx
- Live 1 Hz ISS state vector (lat/lon/alt/vel/period/incl) from SGP4
- SVG equirectangular ground track (±46 min, seam-safe) + JSC marker
- NEXT PASS — JSC HOUSTON (29.5593 N, 95.09 W): AOS/max-el/LOS, compass,
  countdown, following passes. Geometric pass ≥10°; visibility not evaluated.
- CONJUNCTION STATUS — public CDMs involving NORAD 25544 graded against
  NASA ISS thresholds: RED Pc ≥ 1e-4 (DAM/PDAM planning), YELLOW ≥ 1e-5.
  Empty public feed = NOMINAL (valid state, not an error).
- Zero Claude cost. /api/iss cached 5 min (60 s on partial failure).

### Feature 4 — Fragmentation Family Tracker ✅
- lib/fragmentation.ts, components/FragmentationTracker.tsx
- Groups the live 2,000-object sample by launch designator
  (OBJECT_ID "1999-025DEV" → "1999-025") and attributes families to a
  catalog of 11 major breakup events (Fengyun-1C ASAT 2007, Cosmos 2251 /
  Iridium 33 collision 2009, Cosmos 1408 ASAT 2021, CZ-6A breakups 2022 +
  2024, NOAA 16, DMSP F13, Pegasus HAPS, Ariane 1 / SPOT 1, Yunhai 1-02)
- Two-factor attribution (designator AND name regex) so a designator
  collision can never mislabel a family
- Stats: debris share of sample, attributed share, events present

### Feature 5 — Orbital Density Profile ✅
- lib/density.ts, components/DensityProfile.tsx
- ORDEM-style histograms: altitude 100-2000 km (50 km bins) and
  inclination 0-180° (5° bins), hover tooltips with debris / payload /
  rocket-body split, annotations: 700-1000 km KESSLER-CRITICAL shell,
  ISS 420 km, Starlink 550 km, ISS 51.6°, Molniya 63.4°, SUN-SYNC 96-100°
- Single-hue bars (#5FB3FF); green/amber/red reserved for annotations
- Caption states it is a live sample, not the ~46,000-object catalog

### Feature 6 — Space Weather + Reentry Watch ✅
- lib/spaceweather.ts, app/api/spaceweather/route.ts, components/SpaceWeather.tsx
- NOAA SWPC (no key): planetary Kp + G-scale, F10.7 solar flux,
  derived ATMOSPHERIC DRAG REGIME (LOW/MODERATE/ELEVATED/HIGH)
  Endpoints: services.swpc.noaa.gov/products/noaa-planetary-k-index.json
             services.swpc.noaa.gov/json/f107_cm_flux.json
  Parsers pick the NEWEST time_tag (not the last row). 15-min cache.
- REENTRY WATCH: lowest-perigee objects (<300 km) in the sample with
  first-order lifetime from the TLE mean-motion derivative
  (da/dt = (2/3)·a·(ṅ/n)); IMMINENT badge < 30 d. Labelled as an
  optimistic estimate — real decay accelerates.

### Feature 7 — Mission Ops Status Bar ✅
- app/api/health/route.ts, components/MissionStatusBar.tsx
- Header strip: UTC clock · date · DOY · GMST · Julian Date
- Health LEDs: SPACE-TRACK (timed fetchTLEs(1) probe, ONLINE/DEGRADED/
  OFFLINE + newest catalog epoch age) · CLAUDE (key configured — no API
  call) · REGION. /api/health cached 5 min (client polls every 5 min), never returns 500,
  error details secret-scrubbed.

### Shared foundation added in Session 5
- lib/orbital.ts — PURE orbital mechanics helpers used by every new
  feature: JD/GMST, TLE elements, SGP4 propagation with guards for the
  satellite.js 5.0.0 error paths, RIC frame, look angles, decay
  estimate, 2-D probability of collision, NASA ISS thresholds + keep-out
  box, JSC site constants. 42 node tests pass against an ISS-like synthetic TLE.
- lib/debrisClient.ts — one shared browser-side /api/debris sample for
  panels 4/5/6 (one request, 10-min TTL, in-flight dedupe)
- lib/prompts.ts — Screening* API contracts + SCREENING_ASSESSMENT_PROMPT
- app/page.tsx — header holds MissionStatusBar; panels 3,2,5,4,6 are
  full-width sections below Fleet Intelligence. Original 3-panel grid +
  Fleet Intelligence untouched.
- vercel.json — maxDuration 30 for screen/assess/iss/spaceweather/health
  (+ debris and fleet, which also export maxDuration in code)
- lib/spacetrack.ts — rate-limit hygiene (auth logic UNCHANGED): one
  shared in-flight login for concurrent cold callers; shared per-instance
  dataset caches with in-flight dedupe (gp sample keyed by limit, 10 min;
  ONE cdm_public pull of 100 rows, 60 s, sliced per caller); 15 s fetch
  timeout. Steady-state Space-Track budget for one viewer, one instance:
  ~100 requests/hr (limit 300/hr), cold page load ~5 requests (was ~10).

### Session 5 verification (done in the cloud session, not by hand)
- npm run build: CLEAN (11 routes, / = 2.3 kB, first-load JS 89.6 kB)
- npx tsc --noEmit: 0 errors
- Node unit tests (node --experimental-strip-types, scratch dir, not in
  repo): orbital 42, spacetrack 10, screening (unit + brute-force
  cross-check + route + lifecycle), iss 14, spaceweather 25, density 15
  + render smoke, fragmentation 9 — ALL PASS
- Playwright (headless Chromium, every /api/* mocked because the sandbox
  cannot reach Space-Track / Anthropic / NOAA): 15/15 steps pass —
  original 4 panels regression (zone filter, risk score, maneuver plan,
  cascade sim, fleet stats) + all 7 new features; 0 console errors;
  desktop 1440/1280/1024 no horizontal overflow, header 60 px, 3-panel
  grid still fits the viewport; mobile 390 px no overflow.
- Headless SwiftShader draws the map's point sprites as large blobs —
  the UNTOUCHED main branch renders identically under SwiftShader, so
  that is a software-renderer artifact, not a Feature 1 change. Real
  GPUs render the crisp uSize 2.0 dots as before.
- NOT verified here: live Space-Track / Anthropic / NOAA responses.
  First production check after deploy: open every panel once.

---

## Session 6 — SpaceX-Ops Upgrade ✅ (7 features)
Context: ops-relevant features in the SpaceX idiom — first principles,
Starlink autonomous CA at Pc 3e-7 (~36-40 maneuvers/sat/yr), performance,
testing discipline, honest assumptions. The repository itself is part of
the product (README, tests, CI, public API docs), so this session fixed
that too.
Built in a Claude Code cloud session on branch feature/spacex-upgrade, then
SQUASH-merged to main (one commit that builds; the branch's "wip" commits
never reach main) = production deploy. Branch kept on GitHub for reference.

### S6 Feature 1 — Starlink Constellation Monitor ✅
- lib/starlink.ts, components/StarlinkMonitor.tsx
- Public FCC shell table (Gen1 550/53, 540/53.2, 570/70, 560/97.6;
  Gen2 525/53, 530/43, 535/33) + a 480/53 row for the 2026 operating
  altitude (SpaceX, Jan 2026), sample objects classified per shell as
  OPERATIONAL / ORBIT RAISING-LOWERING / DEORBITING / UNASSIGNED, per-shell
  crossing-object exposure (debris / R/B / payload), SVG shell ladder.
- Zero Claude cost. Phase is inferred from ONE element set (says so).

### S6 Feature 2 — Avoidance Burn Planner ✅
- lib/maneuver.ts, components/AvoidancePlanner.tsx (+ lib/screening.ts
  now attaches targetStateEci / secondaryStateEci at TCA to each approach)
- Clohessy-Wiltshire (Hill) linearised relative motion → displacement at
  TCA for an in-track impulse Δv applied τ before TCA; VERIFIED LIVE
  against two-body propagation (lib/orbital twoBodyPropagate).
- Trade space: burn lead {12h…30m} × Δv {1…100 cm/s} × prograde/retrograde
  → new miss + Pc (same assumed covariance as the screen). Decision rule:
  Starlink's Pc ≥ 3e-7 (STARLINK_PC_MANEUVER_THRESHOLD, July 2026 FCC report;
  NASA's 1e-4 red line when the screened target is the ISS). Recommends the
  minimum-Δv burn that clears the threshold; propellant via Tsiolkovsky
  and burn time for vehicle presets (Starlink V2 Mini-class / V1.5-class /
  generic hydrazine bus — public estimates, labelled).
- Pc sensitivity curve vs covariance scale with a DILUTION REGION flag.
- Zero Claude cost. "Planning aid, not flight software" on screen.

### S6 Feature 3 — Launch COLA Screening ✅
- lib/launch.ts, app/api/cola/route.ts, components/LaunchCola.tsx
- Sites: SLC-40, LC-39A, SLC-4E, Starbase. Orbits: Starlink 550/53,
  Gen2 530/43, ISS 420/51.64, SSO 560/97.6. For every launch minute in a
  60/120/240-min window: insertion at T+9 min, 20° downrange, in the
  plane through the site (raanThroughPosition), two-body coast 20 min,
  screened at 30 s steps against the catalog sample (altitude prefilter).
  NO-GO < 5 km, CAUTION < 25 km, else GO; next clear window reported.
- GET /api/cola?site=&orbit=&minutes= (cache keyed per start MINUTE with a
  5-min TTL, so only repeats inside the same minute hit; the panel auto-runs
  one screen when it first scrolls into view; maxDuration 30, compute
  budget + truncated flag). Simplified model — labelled.

### S6 Feature 4 — Orbital Lifetime & FCC 5-Year Disposal Compliance ✅
- lib/lifetime.ts, components/DisposalCompliance.tsx
- Vallado exponential atmosphere (Table 8-4) × crude solar-activity factor
  (LOW 0.5 / MEAN 1 / HIGH 2.5, default from live F10.7), circular-orbit
  decay da/dt = −√(μa)·ρ·B integrated adaptively to 120 km or a 500-year
  cap. Ballistic presets (Starlink-class B 0.04 m²/kg, 3U CubeSat, 1,000 kg
  bus, dense fragment). Checks: FCC 5-year post-mission disposal (2022)
  and the legacy 25-year guideline. Decay curve + lifetime ladder.
- Model numbers for Starlink-class B 0.04 m²/kg at 550 km: ≈ 5.8 y LOW /
  2.9 y MEAN / 1.2 y HIGH activity — SpaceX's public "~5 years" rationale
  sits between LOW and MEAN. The panel prints these next to the result.

### S6 Feature 5 — Public API: OpenAPI + /docs + rate limit + CORS ✅
- lib/apiSpec.ts (single source for the OpenAPI 3.1 doc AND the docs
  page), lib/rateLimit.ts (pure token bucket), app/api/openapi/route.ts,
  app/docs/page.tsx (server component), middleware.ts (Edge: two token
  buckets per IP on /api/* — general 120 burst / 120 per min, expensive
  20 burst / 10 per min for every Claude POST, GET screen/cola and
  uncached debris lookups — X-RateLimit-* headers, 429 JSON, CORS for
  GET/OPTIONS).
- Every route documented with params, response example, curl, cost
  (deterministic vs Claude) and cache. Link "API docs →" in the jump nav.

### S6 Feature 6 — Engineering rigor pack ✅
- tests/*.test.ts (node:test, zero deps, "@/" alias hook in
  tests/register.mjs), package.json scripts "test" + "typecheck",
  .github/workflows/ci.yml (typecheck → test → build; no secrets needed),
  .nvmrc (22), README.md (architecture diagram, features, physics +
  assumptions, API, engineering, local dev — NO credentials or emails).
- npm test must stay green: it is the public proof that the physics is right.

### S6 Feature 7 — System Telemetry ✅
- lib/telemetry.ts (client bus: map tick ms, FPS, per-route latency via
  timedFetch), components/SystemTelemetry.tsx, lib/spacetrack.ts request
  accounting (getSpaceTrackStats) surfaced as spaceTrackBudget on EVERY
  /api/health response (live even when the probe is cached).
- Shows Space-Track budget (last hour / 300, last minute / 30, cache hit
  rate, cookie age), orbit-propagation tick p50/p95 + throughput + frame
  budget, API latency table, on-demand client SGP4 benchmark.
- OrbitalMap.tsx: 3-line hook (recordMapTick / recordMapFps) — shaders etc.
  still untouched.

### Shared foundation added in Session 6
- lib/orbital.ts: STARLINK_PC_MANEUVER_THRESHOLD, siteEci,
  circularOrbitState, raanThroughPosition (ascending pass),
  argumentOfLatitude, twoBodyPropagate (universal variables, Vallado
  Alg. 8), meanMotionRadPerSec — 21 node checks (period round-trip to
  < 1 cm, energy/h conservation, hyperbolic, site-in-plane).
- app/page.tsx: jump nav (anchors for all 11 full-width panels + API
  docs link); Session 6 panels mounted: avoidance, cola, starlink,
  disposal after the screener; telemetry last.
- vercel.json: app/api/cola/route.ts maxDuration 30.

### Session 6 verification (cloud session)
- npm run build: CLEAN — 16 routes (+ /api/cola, /api/openapi), /docs
  static page, Edge middleware 28.6 kB, / first-load JS 96.8 kB.
- npm run typecheck: 0 errors. npm test: 144/144 (orbital, spacetrack
  incl. alias + soft budget, screening, iss, spaceweather, density,
  fragmentation, starlink incl. 480 row + DEB guard, lifetime, maneuver
  at the 3e-7 trigger, launch, rateLimit incl. tier classifier + client
  keys, apiSpec ↔ route handlers) in ~6 s, no network.
- Playwright (headless Chromium, every /api/* mocked): 26/26 — the 15
  Session 5 steps unchanged + 11 Session 6 steps (Starlink rows/ladder,
  avoidance trade space + recommendation + sensitivity, COLA timeline +
  blackout rows, lifetime FCC badge + curve + ladder, telemetry budget /
  map / benchmark, /docs cards + /api/openapi + rate-limit headers);
  0 console errors; no horizontal overflow at 1440 / 1280 / 1024 / 390
  (dashboard and /docs); header 60 px; hero grid budget raised to
  calc(100vh − 10.25rem) to make room for the jump nav (readable
  text-secondary links with 12 px tap padding).
- Five-lens adversarial review (recruiter-repo, page-ux, physics-honesty,
  prod-security, lifecycle-perf) → fixes #26-#33 above; remaining
  judgement calls are listed in the Session 6 lessons.
- Space-Track / Anthropic / NOAA still NOT reachable from the sandbox;
  first production check after deploy: open every panel once, run the
  screener on ISS (planner reads its cached result), run one COLA screen.

---

## Complete File Structure
C:\Users\user\SpaceDebris\
- .env.local                    DONE — Real API keys (NEVER commit)
- .gitignore                    DONE — Covers .env.local + node_modules
- CLAUDE.md                     DONE — This file
- vercel.json                   DONE — Function timeout config
- next.config.js                DONE — .js NOT .ts
- tsconfig.json                 DONE — Strict mode, @/* alias
- tailwind.config.js            DONE — Space theme
- postcss.config.js             DONE — Tailwind pipeline
- package.json                  DONE — All deps
- app/
  - globals.css                 DONE — Space theme + animations
  - layout.tsx                  DONE — Syne + Syne Mono fonts
  - page.tsx                    DONE — 4-panel dashboard (FleetDashboard added)
  - api/
    - debris/route.ts           DONE — TLE fetch, 10-min cache
    - analyze/route.ts          DONE — Claude risk scoring + TLE passthrough
    - conjunctions/route.ts     DONE — CDM alerts, 60s cache
    - cascade/route.ts          DONE — Phase 1 Kessler simulation
    - maneuver/route.ts         DONE — Phase 2 maneuver recommendations
    - fleet/route.ts            DONE — Phase 3 fleet intelligence
    - screen/route.ts           DONE — S5 F2 SGP4 conjunction screening (GET)
    - assess/route.ts           DONE — S5 F2 Claude CA memo (POST)
    - iss/route.ts              DONE — S5 F3 ISS TLE + ISS CDMs
    - spaceweather/route.ts     DONE — S5 F6 NOAA SWPC Kp + F10.7
    - health/route.ts           DONE — S5 F7 subsystem health (+ S6 budget)
    - cola/route.ts             DONE — S6 F3 launch COLA screening (GET)
    - openapi/route.ts          DONE — S6 F5 OpenAPI 3.1 document (GET)
  - docs/page.tsx               DONE — S6 F5 API reference (server component)
- middleware.ts                 DONE — S6 F5 per-IP rate limit + CORS on /api/*
- tests/                        DONE — S6 F6 node:test suites (npm test)
- .github/workflows/ci.yml      DONE — S6 F6 CI: typecheck → test → build
- README.md                     DONE — S6 F6 public README (architecture, physics, API)
- .nvmrc                        DONE — Node 22
- lib/
  - anthropic.ts                DONE — Model: claude-sonnet-4-6
  - spacetrack.ts               DONE — gp class, auth working
  - prompts.ts                  DONE — ALL prompts + types (DO NOT INLINE)
  - orbital.ts                  DONE — S5 shared SGP4 / RIC / Pc physics (PURE)
  - debrisClient.ts             DONE — S5 shared browser debris sample
  - screening.ts                DONE — S5 F2 screening algorithm (PURE)
  - iss.ts                      DONE — S5 F3 ground track, passes, CA grading
  - fragmentation.ts            DONE — S5 F4 breakup catalog + grouping
  - density.ts                  DONE — S5 F5 histogram binning
  - spaceweather.ts             DONE — S5 F6 SWPC parsers + drag regime
  - health.ts                   DONE — S5/S6 health contract types (PURE)
  - telemetry.ts                DONE — S6 client telemetry bus + timedFetch
  - starlink.ts                 DONE — S6 F1 shell table + classification
  - maneuver.ts                 DONE — S6 F2 CW trade space + two-body re-solve
  - launch.ts                   DONE — S6 F3 launch sites, insertion, COLA screen
  - lifetime.ts                 DONE — S6 F4 atmosphere + decay integrator
  - apiSpec.ts                  DONE — S6 F5 endpoint list → OpenAPI + /docs
  - rateLimit.ts                DONE — S6 F5 pure token bucket (Edge-safe)
- components/
  - OrbitalMap.tsx              DONE — Three.js 3D, uSize 2.0 + S5 live propagation
  - RiskScorer.tsx              DONE — Risk scoring + maneuver plan
  - AlertFeed.tsx               DONE — Conjunction feed + cascade sim
  - FleetDashboard.tsx          DONE — Phase 3 fleet intelligence
  - MissionStatusBar.tsx        DONE — S5 F7 header clocks + health LEDs
  - IssConsole.tsx              DONE — S5 F3 ISS TOPO console
  - ConjunctionScreener.tsx     DONE — S5 F2 screening UI + AI memo
  - DensityProfile.tsx          DONE — S5 F5 altitude / inclination charts
  - FragmentationTracker.tsx    DONE — S5 F4 family table
  - SpaceWeather.tsx            DONE — S5 F6 Kp / F10.7 / reentry watch
  - StarlinkMonitor.tsx         DONE — S6 F1 constellation monitor
  - AvoidancePlanner.tsx        DONE — S6 F2 Δv trade space + recommendation
  - LaunchCola.tsx              DONE — S6 F3 launch window timeline
  - DisposalCompliance.tsx      DONE — S6 F4 lifetime + FCC 5-year check
  - SystemTelemetry.tsx         DONE — S6 F7 budget / propagation / latency

---

## Environment Variables — .env.local
ANTHROPIC_API_KEY=Aayush's own key (created Session 4)
SPACETRACK_USERNAME=<your Space-Track login — lives in .env.local only>
SPACETRACK_PASSWORD=set during Space-Track registration

File: C:\Users\user\SpaceDebris\.env.local
NEVER commit. Verify with git status before push.
Same 3 vars in Vercel dashboard — Settings — Env Variables.
ANTHROPIC_API_KEY was updated in BOTH .env.local AND Vercel Session 4.

---

## All Fixes Applied — Sessions 1-4

### Sessions 1-2 (Hackathon)
1. @types/satellite.js removed
2. OrbitControls import uses .js extension
3. Model: claude-sonnet-4-6
4. fetchTLEs — removed ORDINAL/1
5. searchTLE — removed ORDINAL/1
6. tle_latest → gp class (fetchTLEs + searchTLE)
7. Diagnostic console.logs added then removed
8. DEBRIS_LIMIT 800 → 2000
9. Counter shows filtered/total
10. vercel.json generated

### Session 3 (Shader Fix)
11. uSize 7.0 → 2.0 (crisp dots)
12. smoothstep(0.5, 0.0, d) → smoothstep(0.5, 0.3, d)

### Session 4 (Phases 1-3)
13. Phase 1: cascade simulator built and deployed
14. Phase 1 bug: cache key collision fixed
    (composite key: cdmId+sat1Id+sat2Id+tca+miss+prob)
15. Phase 2: maneuver recommendation engine built
16. Phase 2: analyze route passes TLE to frontend
17. Phase 3: fleet intelligence dashboard built
18. ANTHROPIC_API_KEY switched to Aayush's own account
    (aunt's key ran out of credits during testing)

### Session 5 (NASA / JSC upgrade)
19. Seven bolt-on features built on branch feature/nasa-jsc-upgrade
20. satellite.js 5.0.0 quirks guarded in lib/orbital.ts:
    sgp4() returns an ARRAY [false,false] on some errors (not an object);
    satrec.ndot is the RAW TLE field — parse ṅ/2 from line 1 cols 34-43
21. SWPC parsers pick the newest time_tag, not the last array row
22. ISS pass predictor: max elevation tracked during the backward AOS walk
    for passes already in progress
23. Reentry watch requires 0 < perigee < 300 km (rejects corrupt TLEs)
24. Screening keeps the closest approach per secondary (co-orbital objects
    would otherwise produce one row per revolution)

### Session 6 (SpaceX-ops upgrade)
25. PRE-EXISTING BUG FIXED: cdm_public MIN_RNG is METRES, not km. The alert
    feed, fleet severity thresholds, ISS console and the conjunction
    prompt now convert through cdmMissDistanceKm(); "388 km" was 388 m.
    Fleet HIGH/CRITICAL counts become realistic (miss-based tiers finally
    trigger).
26. Fleet Top Threats now rank by Pc first, miss distance as tie-break
    (the old 10/miss + 1000·Pc score let a 150 m / Pc 2e-6 event outrank
    a 600 m / Pc 5e-4 one once MIN_RNG was read correctly).
27. searchTLE aliases bare "ISS" → NORAD 25544 in ONE place
    (lib/spacetrack.ts) and caches single-object lookups 5 min with
    in-flight dedupe; the screen route's private alias is gone. Before,
    the lifetime panel's "ISS" default was a wildcard name search that
    could return ISS DEB or SWISSCUBE.
28. Starlink trigger corrected to Pc 3e-7 (SpaceX semiannual FCC report,
    1 July 2026; earlier filings 1e-5). The planner applies NASA's 1e-4
    red line when the screened target is the ISS and says so on screen;
    its event picker ranks by Pc (what the rule uses), not miss distance.
29. Starlink panel: 480 km / 53° row for the 2026 lowering; "STARLINK-x
    DEB" fragments are debris (crossers), not satellites; ṅ/2 read from
    TLE columns without building an SGP4 record per row (~90 % cheaper).
30. Space-Track SOFT BUDGET enforced per instance in lib/spacetrack.ts
    (25/min, 250/hr under the published 30/300): SpaceTrackBudgetError is
    thrown locally before any HTTP call; /api/health reports a refused
    probe as DEGRADED. Shared dataset cache capped at 64 entries, the
    debris route cache at 16.
31. In-flight dedupe added to the Claude-backed GETs (/api/conjunctions,
    /api/fleet) and to /api/spaceweather, /api/health: concurrent cold
    callers share ONE upstream call. Expensive rate-limit tier burst
    raised 10 → 20 (one viewer clicking every panel spends ~12 in a
    minute); sustained 10/min unchanged.
32. Lifetime panel: F10.7 → activity bands now match the Space Weather
    panel (LOW < 100, HIGH ≥ 200, else MEAN) via the shared constants;
    caution line when the Starlink-class preset is applied to a
    non-Starlink object (with the implied B); ladder memo split from the
    single integration; chart measured in a layout effect.
33. Repo hygiene: Space-Track login e-mail scrubbed from CLAUDE.md (HEAD
    only — history keeps it; rotate the password if that matters), README
    documents both rate-limit tiers, the per-instance budget counters,
    the 15-row screen cap and the CW check honestly; CI actions bumped
    to v5 (node24); apiSpec test pins /docs to the real route handlers.

---

## Space-Track.org API — Critical Facts
- Username: the Space-Track login in .env.local (never commit it)
- Cookie name: chocolatechip (correct — not a bug)
- Cookie parse: setCookie.split(';')[0]
- Rate limit: 30 req/min, 300/hr — lib/spacetrack.ts enforces a SOFT
  per-instance budget of 25/min, 250/hr BEFORE each request
  (SpaceTrackBudgetError, no HTTP call); counters on /api/health
- TLE endpoint: class/gp/ (NOT tle_latest — returns 404)
- CDM endpoint: class/cdm_public/ (working)
- MIN_RNG is in METRES (CCSDS CDM convention) — convert with
  cdmMissDistanceKm() in lib/orbital.ts. Sessions 1-5 displayed it as km
  ("miss 388 km" next to PC 1e-4 — impossible); fixed in Session 6.
- Returns 404 (not 401) when unauthenticated

---

## Three.js Architecture — DO NOT CHANGE WITHOUT TESTING
- THREE.Points (one draw call)
- Custom ShaderMaterial, additive blending
- Log-scale altitude: scene_r = 1.0 + Math.log1p(altKm/2000)*1.4
- OrbitControls from OrbitControls.js (with .js extension)
- DEBRIS_LIMIT = 2000
- uSize = 2.0 (DO NOT change without localhost visual test)
- smoothstep(0.5, 0.3, d) — tight falloff
- 2000 objects = ~80-200ms load (acceptable)

---

## Orbital Band Reference
- LEO: 200-2,000km — 1,815 of 1,989 objects — ELEVATED
- MEO: 2,000-35,786km — 42 objects — NOMINAL (GPS clusters)
- GEO: exactly 35,786km — 143 objects — NOMINAL (equatorial ring)

---

## Key Facts For Demo/Pitch
- 46,000 objects tracked in Earth orbit
- 69,000+ NORAD IDs assigned in history
- 14,500-15,600 currently active satellites
- SpaceX Starlink: 10,000+ satellites (65% of active)
- SpaceX: 300,000 maneuvers in 2025 (50% YoY increase)
- ~36-40 maneuvers per Starlink satellite per year
- Starlink maneuver trigger: Pc 3e-7 (SpaceX semiannual FCC report,
  1 July 2026; earlier filings 1e-5). Industry norm 1e-4.
- Jan 2026: SpaceX began lowering the ~4,400 satellites of the 550 km
  shell to ~480 km (through 2026) — the Starlink panel has a 480 km row
- 500,000+ objects 1-10cm — untrackable kill zone
- Source: SpaceX FCC filing Dec 2025, New Scientist Jan 23 2026
- GEO debris: never deorbits (thousands of years)
- LEO at 550km: ~5 years natural deorbit

---

## Anthropic API
- Model: claude-sonnet-4-6 (NEVER change)
- temperature: 0 on ALL Claude calls
- Cost: $3.00 input / $15.00 output per million tokens
- Session 4 cost: $4.04 for Phases 1-3
- Total project cost: ~$24 across all sessions
- All prompts in lib/prompts.ts — NEVER inline

## API Cost Per Feature
- Risk score: ~$0.006
- Cascade simulation: ~$0.008
- Maneuver plan: ~$0.008
- Fleet intelligence: ~$0.012
- Conjunction summary (x10 per refresh): ~$0.04/refresh
- Session 5 features 1, 3, 4, 5, 6, 7: $0 (deterministic physics, no Claude)
- Session 5 screening (GET /api/screen): $0 (pure SGP4)
- Session 5 AI conjunction assessment memo (POST /api/assess): ~$0.01
- Session 6 features 1-7: $0 — fully deterministic, no Claude calls

---

## Deploy Sequence — EVERY TIME
Run in second terminal — NEVER in Claude Code
Never --force on git push

npm run build
git add .
git commit -m "message"
git push origin main

Wait 60-90s → verify space-debris-two.vercel.app

Pre-deploy checklist:
1. npm run build clean
2. .env.local NOT in git status
3. node_modules NOT in git status
4. Visual test localhost first
5. Vercel env vars still set

---

## Critical Rules — NEVER VIOLATE
1. FULL FILES ONLY — no partial files
2. npm run build before every deploy
3. All prompts in lib/prompts.ts — never inline
4. next.config.js stays .js NOT .ts
5. Model: claude-sonnet-4-6
6. temperature: 0 on all Claude calls
7. Never commit .env.local
8. Never let Claude Code run terminal commands
9. Never hardcode API keys
10. Specify exact file in debug prompts
11. Never --force on git push
12. TLE endpoint: class/gp NOT class/tle_latest
13. Test localhost BEFORE pushing to Vercel
14. Never change shader without localhost visual test
15. Never break existing features adding new ones
16. Always update CLAUDE.md at end of session

---

## Claude Code Operational Notes
- /clear at start of every session
- /cost to check token burn
- Press 2 "Yes allow all edits" to skip confirmations
- Multi-line pastes: double Ctrl+V
- Single-line prompts avoid freeze issues
- Claude Code has NO memory between sessions
- CLAUDE.md IS the memory
- Restart: cd C:\Users\user\SpaceDebris && claude
- First prompt: Read CLAUDE.md entirely before responding

---

## Features Roadmap

### COMPLETED
Phase 1: Kessler Cascade Simulator ✅
Phase 2: Maneuver Recommendation Engine ✅
Phase 3: Fleet Intelligence Dashboard ✅

### Session 5 — NASA / JSC upgrade ✅ (7 features, see above)
Phase 5 "lite" is now REAL: GET /api/screen predicts close approaches
from TLEs before Space-Track publishes a CDM. Full Phase 5 (continuous
all-vs-all propagation, persistence, alerting) remains below.

### NEXT — Phase 4: Operator Alert Network
Satellite operators subscribe to real-time alerts for
their specific assets. When a conjunction involves their
satellite, immediate AI-generated notification is sent.
Files: lib/prompts.ts, app/api/alerts/*, 
       components/AlertSubscription.tsx, app/page.tsx
Complexity: HIGH
Revenue impact: DIRECT — converts free users to paying

### Phase 5: Predictive Conjunction Engine
Predict conjunctions 2 hours before Space-Track publishes.
Run own SGP4 propagation on all 1,989 objects continuously.
Files: lib/propagation.ts, app/api/predict/route.ts,
       components/PredictionFeed.tsx
Complexity: VERY HIGH
Revenue impact: $60M/year value to SpaceX

### Phase 6: Autonomous Satellite Integration
Direct integration with operator command systems.
Autonomous maneuver execution within approved windows.
Complexity: EXTREME (partnerships, certifications, years)
Revenue impact: TRILLION DOLLAR

---

## Business Development
- NASA judge LinkedIn: message sent, awaiting reply
- When he replies: prepare NASA-specific demo immediately
- Target customers: SpaceX, Amazon Kuiper, ESA, insurers
- Best investor fit: Seraphim Capital (space-only VC)
- Best accelerator: Creative Destruction Lab (Waterloo)
- Grant target: NASA SBIR Phase 1 ($150K, sbir.nasa.gov)
- Domain: spacedebris.space (register when ready)
- Also building: Roblox game (use Opus to 10x from $1/day)

## Revenue Strategy
- Phase 4 complete → charge $49-499/month subscriptions
- Phase 5 complete → $10K-100K/year API contracts
- Phase 6 complete → $1M+/year enterprise deals
- FCC compliance angle → mandatory usage for all operators

---

## Session Lessons Learned

### Session 4
- Phase 1-3 built in ~1 hour total
- Total cost: $4.04 (40k + 33k + 40k tokens)
- Aunt's Anthropic API key ran out mid-session
  Fix: Aayush created own account, added $20 credits
  Update BOTH .env.local AND Vercel dashboard when changing keys
- Cascade cache bug: cdmId collision between alerts
  Fix: composite cache key (cdmId+sat1Id+sat2Id+tca+miss+prob)
- Claude Code agents: not yet needed (linear Opus fast enough)
- Sub-agents: not viable yet (shared files cause conflicts)
- Python backend: needed for Phase 5+ (sgp4, numpy, scipy)
- Roblox game ($1/day): use as funding vehicle for SpaceDebris
- Sequential phases: each builds cleanly on previous
- Never start new phase without npm run build clean

### Session 5 (cloud session — NASA / JSC upgrade)
- Built in a Claude Code CLOUD session (claude.ai/code), not the local
  terminal: the agent ran npm install / tsc / npm run build / Playwright
  itself because nobody else could in that container. Rule 8 ("never let
  Claude Code run terminal commands") is a LOCAL-workflow rule; in cloud
  sessions the agent must build + test before pushing.
- Work landed on branch feature/nasa-jsc-upgrade first (Vercel PREVIEW
  deploy), then was merged to main = production deploy.
- Merge gotcha on Windows: the branch existed only on GitHub, so
  `git merge feature/nasa-jsc-upgrade` failed with "not something we can
  merge". Use `git merge origin/<branch>` after `git fetch origin`.
- After a cloud-session push to main, run `git pull origin main` locally
  before editing anything.
- Pattern that worked: shared pure library first (lib/orbital.ts, with a
  node test against an ISS-like synthetic TLE), API contracts second
  (lib/prompts.ts), THEN parallel feature agents on disjoint files, each
  followed by an adversarial review + fix pass, then one build + one
  Playwright run with every /api/* mocked (the sandbox cannot reach
  Space-Track, Anthropic or NOAA).
- Reviews caught real bugs before build: SWPC "last row ≠ newest row",
  in-progress ISS pass max-elevation decay, negative-perigee TLEs leaking
  into the reentry table, label casing that broke text assertions.
- The 2,000 most-recent-epoch gp sample is dominated by recently updated
  payloads (Starlink), so the family tracker and density profile describe
  a SAMPLE, and every panel says so on screen. Never claim full-catalog.
- NOAA SWPC JSON shapes were implemented from documentation (host blocked
  in the sandbox). After the first production deploy, open the Space
  Weather panel once and confirm Kp / F10.7 render; if not, only
  parseKpResponse / parseF107Response in lib/spaceweather.ts need touching.
- Node 22 runs TypeScript directly: node --experimental-strip-types x.ts
  (great for testing pure lib files without a test framework).

### Session 6 (cloud session — SpaceX-ops upgrade)
- Same pattern as Session 5 (shared lib → contracts → parallel feature
  agents on disjoint files → adversarial review → one build + Playwright
  run), then a FIVE-LENS cross-cutting review of the merged tree
  (recruiter-repo, page-ux, physics-honesty, prod-security,
  lifecycle-perf). The cross-cut found what per-feature reviews cannot:
  two panels grading the same event with different rules, a unit fix
  that silently changed a ranking, a public figure that had moved
  (Starlink trigger 1e-5 → 3e-7), and a memory file leaking an e-mail.
- Check public figures against the CURRENT filing before citing them.
  SpaceX's semiannual Starlink reports move: Dec 2025 – May 2026 report
  (filed 1 July 2026) = Pc 3e-7 trigger, ~36 maneuvers/Gen1 sat/yr; the
  550 km shell is being lowered to ~480 km through 2026. Direct-to-Cell
  altitude was NOT verified — do not add a DTC row without a source.
- Per-IP rate limits are a brake, not a spend guarantee. Spend guards
  that actually hold are in the routes (in-flight dedupe per cache
  expiry) and in lib/spacetrack.ts (soft budget). A global per-instance
  Claude bucket in lib/anthropic.ts + a monthly spend cap in the
  Anthropic Console remain the next step.
- Judgement calls left to Aayush (not changed by the agent):
  1. CLAUDE.md is public: the Operator Note, Business Development,
     Revenue Strategy, Roblox / aunt's-key notes and CONTEXT.md read
     oddly next to the README. Move them to an untracked CLAUDE.local.md
     (Claude Code loads it automatically; add it to .gitignore) and
     `git rm --cached .claude/settings.local.json`.
  2. README "Author" could say the project was built with Claude Code
     as a pair programmer — the commit trailers already do.
  3. The Telemetry panel polls /api/health every 60 s while visible even
     when scrolled off; gating it on IntersectionObserver would save
     ~60 invocations/hour per idle viewer.
  4. Merge Session 6 with `git merge --squash` so the "wip" commits
     (which do not build) never land on main's bisectable history.

---

## Git Repository
- GitHub: https://github.com/IQEmperor24/SpaceDebris.git
- Branch: main
- Local: C:\Users\user\SpaceDebris

## Claude Code Setup
- Launch: cd C:\Users\user\SpaceDebris && claude
- Model: Opus 4.7
- First prompt every session:
  /clear
  Read CLAUDE.md entirely before responding.
  Confirm by summarizing what is built, what phases
  are complete, and what Phase we build next.
  Do not read any other files first.

---

## The Vision
SpaceDebris is not a hackathon project anymore.
It is the beginning of the AI infrastructure layer
for the space age.

Sessions 1-2: MVP built and deployed ($20.36)
Session 3:    Shader fixed, dots crisp ($0)
Session 4:    Phases 1-3 complete ($4.04)
Session 5:    NASA / JSC upgrade — 7 features, real SGP4 physics
              (Claude Code cloud session; $0 Anthropic API spend —
              nothing was called at runtime in the sandbox)
Session 6:    SpaceX-ops upgrade — 7 deterministic features,
              public API + docs, in-repo tests + CI + README, and the
              metres→km CDM fix (cloud session; $0 API spend)
Total:        ~$24 invested in API credits

The problem is existential.
The market is trillion dollar.
The NASA connection is active.
The product is live and growing.

Every line of code is a step toward building
the air traffic control system for orbital space.

Build carefully. Build correctly. Build to last.

Houston, we have a solution. 🚀