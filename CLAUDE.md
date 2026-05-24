SpaceDebris — CLAUDE.md
Holy Grail Context File for Claude Code (Opus)
READ THIS ENTIRELY BEFORE RESPONDING TO ANY PROMPT
Last updated: End of Session 3 — Post Houston Hackathon

OPERATOR NOTE — CRITICAL
Aayush is a Waterloo CS grad building SpaceDebris solo.
This is now a POST-HACKATHON production build.
We are building potentially trillion-dollar space
infrastructure. Every decision matters.
As his AI pair programmer, you MUST:

Be EXTREMELY verbose in every response
Never assume he remembers something — restate context every time
Call out potential mistakes BEFORE he makes them
Never give partial files — always give the COMPLETE file, top to bottom
Never say "rest of file stays the same"
Double-check every file for typos, missing imports, broken references
Remind him of the deploy sequence every single time he is about to deploy
Flag any command that could break the build BEFORE he runs it
For ALL debug prompts: "Only look at [FILE]. Do not read any other files."
Never run terminal commands yourself — Aayush runs ALL commands
After EVERY feature: npm run build must be clean before git push


Project Vision
SpaceDebris — AI-powered real-time space debris collision
risk dashboard. Started as 24-hour Houston Hackathon build.
Now being developed into critical space infrastructure.
The Pitch
"46,000 objects are tracked in Earth orbit. SpaceX performed
300,000 collision avoidance maneuvers in 2025 — a 50% increase
over 2024. One collision can trigger Kessler Syndrome — a chain
reaction that makes all orbits permanently unusable, killing GPS,
internet, and weather satellites forever. SpaceDebris is the AI
infrastructure layer that monitors, predicts, and prevents that."
Market Opportunity

SpaceX spends ~$300M/year on collision avoidance maneuvers
Global satellite insurance market: $1B/year
Space economy projected $1 trillion by 2040 (Goldman Sachs)
FCC requires biannual safety reports from all operators
No standardized AI tool exists for conjunction risk assessment

Key Connection
NASA-connected judge at HackHCC Houston sent LinkedIn
connection request after seeing SpaceDebris demo.
Introduction to NASA pending. Follow up actively.

Live Deployment

URL: https://space-debris-two.vercel.app
Vercel Authentication: DISABLED (fully public)
GitHub: https://github.com/IQEmperor24/SpaceDebris.git
Branch: main
Last commit: 9d59a4d — "feat: crisp debris dots uSize 2.0"
Auto-deploys on every git push origin main
vercel --prod CLI NOT needed — push to GitHub = auto deploy


Tech Stack

Next.js 14.2.3 App Router
TypeScript (strict mode ON)
Tailwind CSS
Three.js (3D orbital visualization)
satellite.js (SGP4 TLE propagation)
Anthropic Claude API — model: claude-sonnet-4-6
Space-Track.org API (live TLE + CDM data)
Vercel (deployment, Hobby plan)


Current Status — What Is Working RIGHT NOW
FULLY WORKING (as of Session 3)

App boots cleanly at localhost:3000
npm run build — CLEAN, zero errors
3D Earth globe renders at 47-60 FPS
Background stars render correctly
ALL/LEO/MEO/GEO filter buttons working correctly
Object counter shows filtered/total (e.g. "1612 / 1986 objects")
~1,986 debris objects loading from Space-Track gp class
Debris dots render as distinct individual points — FIXED SESSION 3
AI Risk Scorer — all 5 chips working
ISS chip — returns real AI risk score
Collision Alert Feed — FULLY WORKING WITH REAL DATA

Fetches real CDMs from Space-Track.org
Claude summarizes in plain English
Threat badges (LOW/MEDIUM/HIGH/CRITICAL)
Auto-refresh countdown timer working
TCA, miss distance, probability displaying correctly


Deployed live at space-debris-two.vercel.app
Vercel public access enabled (no login required)
vercel.json generated (function timeout config)
GitHub connected to Vercel (auto-deploy on push)
Devpost submitted to HackHCC: Code Runners
Demo video submitted

KNOWN ISSUES (acceptable, do not fix now)

Mobile rendering: dots not fully visible on phones
(WebGL shader limitation — judges demo on desktop)
Object count ~1,986 not 2,000 — Space-Track drops
objects with invalid/stale TLEs. Normal, not a bug.
LEO appears as dense glowing shell (scientifically
correct — 1,811 objects packed tightly in LEO band)

FEATURES TO BUILD (Session 3+)
Phase 1: Kessler Cascade Simulator — BUILD NEXT
Phase 2: Maneuver Recommendation Engine
Phase 3: Fleet Intelligence Dashboard
Phase 4: Operator Alert Network
Phase 5: Predictive Conjunction Engine
Phase 6: Autonomous Satellite Integration (long term)

Complete File Structure
C:\Users\user\SpaceDebris\

.env.local                    DONE — Real API keys (NEVER commit)
.gitignore                    DONE — Covers .env.local + node_modules
CLAUDE.md                     DONE — This file — Claude Code rulebook
vercel.json                   DONE — Function timeout config
next.config.js                DONE — Stays as .js NOT .ts — never rename
tsconfig.json                 DONE — Strict mode, @/* alias
tailwind.config.js            DONE — Space theme colors
postcss.config.js             DONE — Tailwind pipeline
package.json                  DONE — All deps, @types/satellite.js REMOVED
package-lock.json             DONE — Do not edit manually
node_modules/                 DONE — Installed, gitignored
app/

globals.css                 DONE — Full space theme + animations
layout.tsx                  DONE — Syne + Syne Mono fonts
page.tsx                    DONE — 3-panel dashboard, dynamic imports
api/

debris/route.ts           DONE — TLE fetch, 10-min cache
analyze/route.ts          DONE — Claude risk scoring
conjunctions/route.ts     DONE — CDM alerts, 60s cache — WORKING




lib/

anthropic.ts                DONE — Model: claude-sonnet-4-6
spacetrack.ts               DONE — gp class, auth working
prompts.ts                  DONE — All Claude prompts + shared types


components/

OrbitalMap.tsx              DONE — Three.js 3D — uSize 2.0 FIXED
RiskScorer.tsx              DONE — AI risk scoring UI
AlertFeed.tsx               DONE — Live conjunction feed — WORKING




Environment Variables — .env.local
ANTHROPIC_API_KEY=<from SkinAI project>
SPACETRACK_USERNAME=a2khazan@uwaterloo.ca
SPACETRACK_PASSWORD=<set during Space-Track registration>
File: C:\Users\user\SpaceDebris.env.local
NEVER commit this file. Verify with git status before push.
Same 3 vars set in Vercel dashboard — Settings — Env Variables

ALL Fixes Applied — Sessions 1, 2, 3
Session 1 Fixes

@types/satellite.js removed from package.json
OrbitControls import changed to OrbitControls.js
CLAUDE_MODEL changed to claude-sonnet-4-6
fetchTLEs — removed ORDINAL/1 from URL path
searchTLE — removed ORDINAL/1 from URL path

Session 2 Fixes

lib/spacetrack.ts — changed tle_latest to gp class
Root cause: tle_latest returns HTTP 404 (deprecated)
gp is Space-Track's current standard TLE endpoint
lib/spacetrack.ts — changed tle_latest to gp in searchTLE
lib/spacetrack.ts — improved error message (full URL)
lib/spacetrack.ts — diagnostic console.logs added then
removed (confirmed auth working: HTTP 200, chocolatechip
cookie valid)
components/OrbitalMap.tsx — DEBRIS_LIMIT 800 to 2000
Performance tested: 2000 = ~80-200ms load (acceptable)
Do not increase beyond 2000 without performance testing
components/OrbitalMap.tsx — counter fixed to show
filtered/total (e.g. "1612 / 1986 objects")
vercel.json — generated (function timeout config)
.next cache — cleared once (rmdir /s /q .next)

Session 3 Fixes

components/OrbitalMap.tsx — shader values updated:
uSize: 7.0 to 2.0 (smaller, crisper debris dots)
smoothstep(0.5, 0.0, d) to smoothstep(0.5, 0.3, d)
Result: distinct individual dots at 60 FPS
Visual confirmed working on Vercel production
DO NOT change shader values without visual testing
on localhost first — blob rendering can return


Space-Track.org API — Critical Facts

Username: a2khazan@uwaterloo.ca
Auth: session cookie (valid ~50 min, auto-refreshed)
Cookie name: chocolatechip (correct — not a bug)
Cookie parse: setCookie.split(';')[0]
Rate limit: 30 req/min, 300/hr
Base URL: https://www.space-track.org
Login: POST https://www.space-track.org/ajaxauth/login
Query base: https://www.space-track.org/basicspacedata/query/
TLE endpoint: class/gp/ (NOT tle_latest — returns 404)
CDM endpoint: class/cdm_public/ (working, do not touch)
Space-Track returns 404 (not 401) for unauthenticated requests
Auth confirmed working: HTTP 200, chocolatechip cookie valid


Three.js Architecture — DO NOT CHANGE WITHOUT TESTING

THREE.Points (one draw call for all debris)
Custom ShaderMaterial with additive blending + circular falloff
Log-scale altitude: scene_r = 1.0 + Math.log1p(altKm/2000)*1.4
ECI to ECF to Three.js: ECF.x to Three.x, ECF.z to Three.y, ECF.y to Three.-z
OrbitControls from three/examples/jsm/controls/OrbitControls.js
Full cleanup on unmount: cancelAnimationFrame + dispose()
DEBRIS_LIMIT = 2000 (do not increase without perf testing)
uSize = 2.0 (do not change without visual testing on localhost)
smoothstep(0.5, 0.3, d) — tight falloff for distinct dots
Propagation cost: ~40-100 microseconds per object on laptops
2000 objects = ~80-200ms load freeze (acceptable)
3000+ objects = visible stutter (do not go there)


Orbital Band Reference (for feature building)

LEO: 200-2,000km — ISS, Starlink, most debris
1,811 of 1,986 objects — densest band
17,500 mph — paint fleck hits like bowling ball
Kessler Syndrome starts here
MEO: 2,000-35,786km — GPS, Galileo, GLONASS, BeiDou
48 of 1,986 objects — GPS constellation clusters
$1.4 trillion economic activity daily depends on MEO
GEO: exactly 35,786km — weather, TV, military sats
127 of 1,986 objects — equatorial ring
Debris here NEVER deorbits (thousands of years)
Finite slots — countries fight over them at UN


Key Facts For Demo/Pitch

46,000 objects tracked in Earth orbit (not 27,000)
69,000+ NORAD IDs assigned in history
14,500-15,600 currently active satellites
SpaceX Starlink: 10,000+ of active satellites (65%)
SpaceX: 300,000 maneuvers in 2025 (50% increase over 2024)
~40 maneuvers per Starlink satellite per year
SpaceX maneuver threshold: 3 in 10 million (vs industry
standard 1 in 10,000 — SpaceX is 300x more cautious)
500,000+ objects 1-10cm — too small to track, big enough
to destroy any satellite (untrackable kill zone)
GEO debris deorbit time: thousands of years (never)
LEO debris at 550km: ~5 years to deorbit naturally
Source for 300K maneuvers: SpaceX FCC filing Dec 2025,
reported by New Scientist Jan 23, 2026


Anthropic API

Model: claude-sonnet-4-6 (always — never change)
temperature: 0 on ALL Claude calls (deterministic)
Cost: $3.00 input / $15.00 output per million tokens
Per risk score call: ~$0.006
API key will NOT burn out during normal usage
All prompts live in lib/prompts.ts — never inline


Deploy Sequence — EVERY TIME, IN ORDER
Run in second terminal — NEVER in Claude Code
Never use --force on git push
Vercel auto-deploys after push — no vercel --prod needed
npm run build
git add .
git commit -m "your message here"
git push origin main
Wait 60-90 seconds then verify space-debris-two.vercel.app
Pre-Deploy Checklist

npm run build clean (zero errors)
.env.local NOT in git status
node_modules NOT in git status
Visual test on localhost before pushing
All 3 Vercel env vars still set in dashboard


Critical Rules — NEVER VIOLATE

FULL FILES ONLY — never partial files or code snippets
npm run build before every deploy
All prompts in lib/prompts.ts — never inline in routes
next.config.js stays as .js NOT .ts
Model string is claude-sonnet-4-6
temperature: 0 on all Claude API calls
Never commit .env.local
Never let Claude Code run terminal commands
Never hardcode API keys
For debug prompts: specify exact file, no others
Never use --force on git push
TLE endpoint is class/gp NOT class/tle_latest
Test visually on localhost BEFORE pushing to Vercel
Never change shader values without localhost visual test
Never break existing features when adding new ones


Debug Prompt Template — USE THIS EVERY TIME
Error in [EXACT FILE] at line [N]:
[PASTE EXACT ERROR]
Only look at [EXACT FILE].
Fix by [EXACT FIX IF KNOWN].
Show complete fixed file top to bottom.
Do not read any other files.

Claude Code Operational Notes

Claude Code auto-applies edits (checkmark = written to disk)
Multi-line pastes: double Ctrl+V (paste again to expand)
Long prompts: use single-line to avoid paste glitch
"accept edits on" = edits PENDING, press Enter to apply
Press 2 "Yes allow all edits this session" to skip confirmations
/clear at start of each session (fresh context, saves money)
/cost to check token burn
Claude Code reads CLAUDE.md automatically as rulebook
Claude Code has NO memory between sessions
Restart: cd C:\Users\user\SpaceDebris && claude
First prompt: Read CLAUDE.md entirely before responding
58% of usage at >150k context = expensive. Use /compact


Session Lessons Learned
Session 1

@types/satellite.js does not exist on npm
OrbitControls needs .js extension in import

Session 2

Space-Track tle_latest class deprecated — use gp
Space-Track returns 404 (not 401) when unauthenticated
Cookie name is chocolatechip (not a bug)
Diagnosis: add console.logs, confirm auth, then remove
Never exit Claude Code — use second terminal
.next cache clear: rmdir /s /q .next (second terminal)
Multi-line paste in Claude Code causes es.es.es bug
Vercel auto-deploys on git push (GitHub webhook active)
vercel --prod not needed when GitHub connected
Deploy AFTER pushing code (not before)

Session 3

uSize 7.0 created blob rendering at high object density
uSize 2.0 + smoothstep(0.5, 0.3, d) = crisp distinct dots
Always test shader changes on localhost before Vercel push
Chrome throttles background tabs (Paused = low FPS)
Click on globe to wake tab from Chrome throttling
LEO dense shell is scientifically correct (not a bug)
MEO 6 clusters = GPS orbital planes (correct, impressive)
GEO arc = geostationary belt (correct, impressive)
Demo: start with ALL filter, show MEO for GPS clusters
46,000 tracked objects (not 27,000 — update your facts)
NASA judge LinkedIn connection = more valuable than prize
Scheduling app won HackHCC (use as fuel, not discouragement)


Business Development Notes

NASA-connected judge: sent LinkedIn request post-demo
LinkedIn message sent Day 1 post-hackathon
Next step: await response, prepare NASA demo version
Target customers: SpaceX, Amazon Kuiper, ESA, insurance cos
Regulatory angle: FCC compliance standardization
Revenue model: API calls + enterprise contracts + SBIR grants
NASA SBIR Phase 1: $150,000 non-dilutive grant available
Apply at: sbir.nasa.gov
Domain to register: spacedebris.space (GoDaddy promo available)
List on: RapidAPI, Product Hunt, GitHub
Write: Dev.to blog post about 24-hour build story


Features Roadmap (Session 3+)
Phase 1 — Kessler Cascade Simulator — NEXT
Simulate cascade effects of any conjunction event.
Files: lib/prompts.ts, app/api/cascade/route.ts,
components/AlertFeed.tsx
Complexity: LOW (pure Claude AI, no new infrastructure)
Impact: HIGH (narrative weapon for NASA/SpaceX demos)
Phase 2 — Maneuver Recommendation Engine
Generate specific burn recommendations for conjunctions.
Files: lib/prompts.ts, app/api/maneuver/route.ts,
components/RiskScorer.tsx
Complexity: MEDIUM (orbital mechanics reasoning)
Impact: HIGH ($60M/year value to SpaceX)
Phase 3 — Fleet Intelligence Dashboard
Real-time health monitoring for satellite constellations.
Files: lib/prompts.ts, app/api/fleet/route.ts,
components/FleetDashboard.tsx, app/page.tsx
Complexity: MEDIUM (new component + API route)
Impact: VERY HIGH (Bloomberg Terminal for space)
Phase 4 — Operator Alert Network
Subscription-based real-time conjunction alerts.
Files: lib/prompts.ts, app/api/alerts/*,
components/AlertSubscription.tsx, app/page.tsx
Complexity: HIGH (subscriptions, webhooks, state)
Impact: HIGH (recurring revenue model)
Phase 5 — Predictive Conjunction Engine
Predict conjunctions before Space-Track publishes CDMs.
Files: lib/propagation.ts, app/api/predict/route.ts,
components/PredictionFeed.tsx, app/page.tsx
Complexity: VERY HIGH (orbital mechanics, performance)
Impact: CRITICAL (2-hour advantage over government data)
Phase 6 — Autonomous Satellite Integration
Direct integration with satellite command systems.
Complexity: EXTREME (requires industry partnerships)
Impact: TRILLION DOLLAR (air traffic control for space)

Git Repository

GitHub: https://github.com/IQEmperor24/SpaceDebris.git
Branch: main
Local: C:\Users\user\SpaceDebris

Claude Code Setup

Launch: cd C:\Users\user\SpaceDebris && claude
Model: Opus 4.7
First prompt every session:
/clear then: Read CLAUDE.md entirely before responding.
Confirm by summarizing current status, what is broken,
and what was fixed. Do not read any other files first.


The Vision
SpaceDebris is not a hackathon project anymore.
It is the beginning of the AI infrastructure layer
for the space age.
The problem is existential. The market is trillion dollar.
The technical moat is real. The NASA connection is active.
Every line of code from here is a step toward building
the air traffic control system for orbital space.
Build carefully. Build correctly. Build to last.
Houston, we have a solution.