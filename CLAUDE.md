# SpaceDebris — CLAUDE.md
# Holy Grail Context File for Claude Code (Opus)
# READ THIS ENTIRELY BEFORE RESPONDING TO ANY PROMPT
# Last updated: End of Session 4 — Post Houston Hackathon
# Phases 1, 2, 3 COMPLETE

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
- Next.js 14.2.3 App Router
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
- lib/
  - anthropic.ts                DONE — Model: claude-sonnet-4-6
  - spacetrack.ts               DONE — gp class, auth working
  - prompts.ts                  DONE — ALL prompts + types (DO NOT INLINE)
- components/
  - OrbitalMap.tsx              DONE — Three.js 3D, uSize 2.0
  - RiskScorer.tsx              DONE — Risk scoring + maneuver plan
  - AlertFeed.tsx               DONE — Conjunction feed + cascade sim
  - FleetDashboard.tsx          DONE — Phase 3 fleet intelligence

---

## Environment Variables — .env.local
ANTHROPIC_API_KEY=Aayush's own key (created Session 4)
SPACETRACK_USERNAME=a2khazan@uwaterloo.ca
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

---

## Space-Track.org API — Critical Facts
- Username: a2khazan@uwaterloo.ca
- Cookie name: chocolatechip (correct — not a bug)
- Cookie parse: setCookie.split(';')[0]
- Rate limit: 30 req/min, 300/hr
- TLE endpoint: class/gp/ (NOT tle_latest — returns 404)
- CDM endpoint: class/cdm_public/ (working)
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
- ~40 maneuvers per Starlink satellite per year
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
Total:        ~$24 invested

The problem is existential.
The market is trillion dollar.
The NASA connection is active.
The product is live and growing.

Every line of code is a step toward building
the air traffic control system for orbital space.

Build carefully. Build correctly. Build to last.

Houston, we have a solution. 🚀