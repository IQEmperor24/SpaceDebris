# SpaceDebris — Houston Hackathon Context File
# Read this ENTIRELY before responding to ANY prompt.
# This file is the single source of truth for every decision in this project.

## OPERATOR NOTE — CRITICAL
Aayush is operating on 3 hours of sleep during a 24-hour hackathon.
He is VERY prone to human error right now.
As his AI pair programmer, you MUST:
- Be EXTREMELY verbose in every response
- Never assume he remembers something from earlier — restate context every time
- Call out potential mistakes BEFORE he makes them
- If something looks wrong, say so immediately and explicitly
- Never give partial files — always give the COMPLETE file, top to bottom
- Never say "rest of file stays the same" — always show the FULL file
- Double-check every file for typos, missing imports, and broken references before outputting
- Remind him of the deploy sequence every single time he is about to deploy
- If he asks for a code change, rewrite the ENTIRE file, not just the changed section
- Flag any command that could break the build BEFORE he runs it

## Who I Am
- Aayush (IQEmperor24 on GitHub)
- Waterloo CS graduate, top 2.5% LeetCode
- Just shipped SkinAI — a live consumer AI wellness app with real users
- Solo founder, learning Next.js/TypeScript while building
- Tool workflow: Claude as strategic advisor + prompt engineer,
  Cursor/Claude Code for file edits
- 24 hours to build and demo SpaceDebris at a Houston hackathon

## The Hackathon
- Location: Houston, Texas (NASA Johnson Space Center territory)
- Timeline: 24 hours
- Judging criteria: Real-world impact
- Solo competitor
- Goal: WIN
- Tracks entered:
  - General Track (primary — no guardrails, anything goes)
  - Best Use of AI (side challenge — Claude interpreting orbital mechanics)
  - Best Solo Hack (side challenge — prize is a Raspberry Pi 5 Kit)

## The Project — SpaceDebris
An AI-powered real-time space debris collision risk dashboard.

### The Pitch (memorize this)
"27,000 pieces of debris orbit Earth right now. One collision can
trigger Kessler Syndrome — a chain reaction that makes all orbits
unusable forever, killing GPS, internet, and weather satellites.
I built a real-time AI risk dashboard that scores collision threats
and recommends avoidance maneuvers using live Space-Track.org data."

### Why This Wins
- Real-world impact is the judging criteria — Kessler Syndrome
  ending civilization's orbital infrastructure is maximum impact
- Houston = NASA Johnson Space Center judges who feel this deeply
- Live real data from Space-Track.org — not fake/mocked
- AI risk scoring is novel and demonstrable live on stage
- Solo founder shipping in 24 hours is a compelling narrative

## Tech Stack
- Next.js 14 App Router (same as SkinAI — Aayush knows this cold)
- Tailwind CSS
- Anthropic claude-sonnet-4-6 via API (same as SkinAI)
  *** CRITICAL: The model string is ALWAYS claude-sonnet-4-6 ***
  *** NEVER use claude-sonnet-4-6 or any other string ***
- Three.js for 3D orbital visualization (replaces D3.js)
- satellite.js for real TLE → ECI → ECF position propagation
- Space-Track.org API for live TLE debris data
- Vercel for deployment
- TypeScript throughout

## Sponsor Integrations (prize tracks)
These are planned integrations for sponsor challenge prizes.
Build the core product first, then layer these in.

- ElevenLabs: voice-read CRITICAL alerts aloud after Claude response
  → Single POST to ElevenLabs API after Claude returns CRITICAL threat
  → Plays audio in browser using Web Audio API
  → High demo impact in a loud hackathon room — judges will notice

- MongoDB Atlas: persist risk scores + AI reports, replace in-memory caches
  → Every Claude risk score gets saved as a document in Atlas
  → Replaces the in-memory cache in /api/debris and /api/conjunctions
  → Adds Mission History search using Atlas Vector Search

- GoDaddy: register spacedebris.space, point to Vercel deployment
  → Register domain via GoDaddy dashboard
  → Add CNAME record pointing to Vercel deployment URL
  → Low effort, high polish — real domain during demo

- Snowflake: historical risk score warehouse, Threat History panel
  → Every risk score fetch gets written to Snowflake via REST API
  → Adds a fourth panel: Threat History Timeline
  → Pitch: "institutional memory of Earth's debris threat"

- Solana: on-chain immutable log of CRITICAL conjunction events
  → When Claude scores CRITICAL, mint a timestamped record to Solana
  → Uses @solana/web3.js — single call after Claude API response
  → Pitch: "tamper-proof audit trail of when risks were known"

- Gemini: dual-AI consensus scoring alongside Claude
  → Fan out /api/analyze to both Claude and Gemini in parallel
  → Show both risk assessments side by side
  → Pitch: "ensemble AI — if both flag CRITICAL, that's a stronger signal"

## What We're Building — 3 Panels

### Panel 1 — Live 3D Orbital Map (Three.js)
- TRUE 3D visualization using Three.js WebGL renderer
- Real orbital positions computed via satellite.js SGP4 propagator
- TLE data → ECI coordinates → ECF coordinates → Three.js scene space
- Earth sphere with atmosphere glow and rim shader
- Debris as THREE.Points (ONE draw call for all objects — 60fps guaranteed)
- Custom ShaderMaterial: soft additive glow per dot
- Log-scale altitude compression so LEO/MEO/GEO all visible together
- Zone shell wireframes at LEO boundary, GPS/MEO, and GEO belt
- 2000 background stars for depth
- OrbitControls: drag to rotate, scroll to zoom, auto-rotates slowly
- Color coded by risk: green (stable >800km) → amber (caution 400-800km) → red (high risk <400km)
- Filterable by orbital zone: ALL / LEO / MEO / GEO
- Hover tooltip: object name, NORAD ID, altitude, type
- FPS counter displayed live

### Panel 2 — AI Risk Scorer
- Input: satellite name or NORAD ID
- Quick search chips: ISS, HUBBLE, STARLINK-1234, 25544, NOAA 19
- Fetches that object's TLE data + nearby objects from Space-Track
- Feeds to Claude with structured prompt
- Returns risk report with scores:
  - Collision probability score (0-100)
  - Debris density score (0-100)
  - Orbital stability score (0-100)
  - Overall threat level (LOW/MEDIUM/HIGH/CRITICAL)
  - Recommended avoidance maneuver in plain English
  - Time to closest approach
- Animated score bars (fill animation on load)
- Orbital data grid: altitude, period, inclination

### Panel 3 — Collision Alert Feed
- Pulls conjunction data from Space-Track API (CDM = Conjunction Data Messages)
- Claude summarizes each threat in plain English
- Auto-refreshes every 60 seconds with live countdown timer
- Sorted by urgency (most imminent first)
- Each alert shows: objects involved, closest approach distance,
  probability, AI recommendation, time to TCA
- CRITICAL alerts pulse red
- Cached 60 seconds to respect Space-Track rate limits

## File Structure
SpaceDebris/
├── app/
│   ├── page.tsx              # Main dashboard — all 3 panels
│   ├── layout.tsx            # Root layout — dark space theme
│   ├── globals.css           # CSS variables + space animations
│   └── api/
│       ├── debris/route.ts       # Fetches TLE data from Space-Track (10min cache)
│       ├── conjunctions/route.ts # Fetches conjunction events (60s cache)
│       └── analyze/route.ts      # Claude risk scoring
├── lib/
│   ├── spacetrack.ts         # Space-Track API client (session cookie auth)
│   ├── anthropic.ts          # Anthropic client singleton
│   └── prompts.ts            # ALL Claude prompts — never inline prompts elsewhere
├── components/
│   ├── OrbitalMap.tsx        # Three.js 3D visualization — 'use client', SSR off
│   ├── RiskScorer.tsx        # Panel 2 — AI scorer — 'use client'
│   └── AlertFeed.tsx         # Panel 3 — live alerts — 'use client'
├── CONTEXT.md                # This file — always read before responding
├── next.config.js            # *** MUST stay as .js NOT .ts — never rename ***
├── tailwind.config.js        # Tailwind config
├── postcss.config.js         # PostCSS config
├── tsconfig.json             # TypeScript config
├── package.json              # Dependencies
├── vercel.json               # Vercel function timeout config
├── .gitignore                # MUST include .env.local — never commit API keys
└── .env.local                # *** NEVER commit this file — API keys live here ***

## Environment Variables
*** These go in .env.local ONLY — never hardcode them anywhere ***
*** Add them to Vercel dashboard separately before deploying ***

ANTHROPIC_API_KEY=           # From Anthropic Console — same as SkinAI
SPACETRACK_USERNAME=         # Email used to register at space-track.org
SPACETRACK_PASSWORD=         # Password for space-track.org account

## Space-Track.org API
- Free registration at space-track.org
  *** REGISTER NOW — account approval can take a few hours ***
- REST API returning TLE (Two-Line Element) data
- TLE = two lines of numbers encoding orbital parameters
- Key endpoints:
  - Login: POST https://www.space-track.org/ajaxauth/login
  - TLE data: GET https://www.space-track.org/basicspacedata/query/class/tle_latest
  - Conjunctions: GET https://www.space-track.org/basicspacedata/query/class/cdm_public
- Must maintain session cookie for authenticated requests
- Rate limit: 30 requests/minute, 300/hour
- lib/spacetrack.ts handles session caching — cookie reused for 50 minutes

## TLE Data Explained
TLE = Two-Line Element set. Encodes orbital parameters:
Line 1: Satellite number, epoch, drag term, element set number
Line 2: Inclination, RAAN, eccentricity, argument of perigee,
        mean anomaly, mean motion, revolution number
satellite.js propagates these via SGP4 into real XYZ ECI coordinates.
Claude also understands raw TLE — feed numbers directly into prompts.

## Three.js 3D Architecture (OrbitalMap.tsx)
*** This is the most complex component — handle with care ***

Key decisions already made — do NOT change these:
- THREE.Points for all debris (one draw call = 60fps with thousands of objects)
- Custom ShaderMaterial (not PointsMaterial) for soft additive glow effect
- Log-scale altitude: scene_r = 1.0 + log1p(altKm / 2000) * 1.4
  (compresses 35786km GEO to be visible alongside 400km LEO)
- ECI → ECF coordinate mapping:
  ECF x → Three.js x
  ECF z → Three.js y  (Three.js is y-up)
  ECF y → Three.js -z
- OrbitControls from 'three/examples/jsm/controls/OrbitControls'
- Component is dynamic import with ssr: false in page.tsx
- useRef for renderer, scene, camera, controls, points, objectData
- Cleanup on unmount: cancelAnimationFrame + controls.dispose + renderer.dispose

## Claude Prompt Strategy
Same pattern as SkinAI — structured JSON output:
- System prompt: orbital mechanics expert + risk assessor
- User prompt: TLE data + nearby objects + request for risk scores
- Output: JSON with scores + plain English recommendations
- temperature: 0 on ALL API calls — never change this
- All prompts live in lib/prompts.ts — NEVER inline prompts in API routes

## Example Risk Score Output Format
{
  "collisionProbability": 23,
  "debrisDensity": 67,
  "orbitalStability": 45,
  "overallThreat": "MEDIUM",
  "closestApproach": "2.3km in 4.2 hours",
  "recommendation": "Minor prograde burn of 0.5m/s recommended
    within next 2 hours to increase separation distance",
  "summary": "Object is operating in a moderately congested
    orbital regime with several nearby defunct satellites...",
  "altitudeKm": 412,
  "periodMinutes": 92.7,
  "inclinationDeg": 51.6
}

## Design System — Space Theme
- Background: #000008 (deep space black)
- Primary accent: #00FF41 (matrix green for safe)
- Warning: #FFB800 (amber for caution)
- Danger: #FF3131 (red for critical)
- Text primary: #E0E0E0
- Text secondary: #888888
- Text muted: #444444
- Glass cards: rgba(255,255,255,0.04) background, 1px border rgba(255,255,255,0.08)
- Font display: Syne (Google Fonts)
- Font mono: Syne Mono (Google Fonts)
- Animations: slow orbital rotation, pulsing alerts, scan lines, blink cursor

## npm Packages — Full List
*** Run npm install AFTER Claude Code generates package.json ***
*** Never run npm install before package.json exists ***

Core:
- next@14.2.3
- react@^18
- react-dom@^18
- typescript@^5

AI + Data:
- @anthropic-ai/sdk@^0.24.0
- satellite.js@^5.0.0

Visualization:
- three@^0.165.0
- d3@^7.9.0 (kept as fallback, not used in OrbitalMap)

Dev + Types:
- @types/node@^20
- @types/react@^18
- @types/react-dom@^18
- @types/three@^0.165.0
- @types/d3@^7.4.3
- @types/satellite.js@^4.0.1
- tailwindcss@^3.4.3
- autoprefixer@^10.4.19
- postcss@^8.4.38
- eslint@^8
- eslint-config-next@14.2.3

## API Route Summary
All routes are in app/api/*/route.ts

GET  /api/debris?limit=500     → fetches TLE sample for orbital map (10min cache)
GET  /api/debris?search=ISS    → searches TLE by name (for risk scorer)
POST /api/analyze              → body: { query: string } → Claude risk score
GET  /api/conjunctions         → CDM conjunction alerts, Claude summarized (60s cache)

## Hour-by-Hour Build Schedule
Hours 1-2:   Setup, Space-Track registration, env vars, npm install
Hours 3-5:   OrbitalMap.tsx with Three.js (biggest component — do this fresh)
Hours 6-8:   /api/debris route + Space-Track integration
Hours 9-11:  Claude risk scoring + /api/analyze route
Hours 12-14: RiskScorer.tsx UI panel
Hours 15-17: AlertFeed.tsx + /api/conjunctions route
Hours 18-20: Full integration + sponsor integrations (ElevenLabs first)
Hours 21-22: Deploy to Vercel + spacedebris.space domain (GoDaddy)
Hours 23-24: Pitch prep + sleep (set alarm — do not skip sleep)

## Winning Demo Flow (3 minutes)
1. Open dashboard — judges see 3D Earth with debris dots orbiting in real time
2. Say: "Every dot is a real object. Its position is computed right now
   from live TLE data via satellite.js SGP4 propagation."
3. Type "ISS" into risk scorer — get live AI risk report in ~10 seconds
4. Show collision alert feed auto-updating with AI summaries
5. If ElevenLabs integrated: let it read a CRITICAL alert aloud
6. Drop Kessler Syndrome explanation — make it visceral:
   "One collision cascades into thousands. GPS goes dark.
   Weather forecasting stops. Internet satellites fall.
   This dashboard exists to prevent that."
7. Close: "I shipped a consumer AI product last week with real paying users.
   I built this in 24 hours, alone. Imagine what 6 months looks like."

## Workflow Rules — NEVER VIOLATE THESE
1. FULL FILES ONLY — never give isolated code blocks or partial files
2. Run npm run build before every single deploy — catch errors locally first
3. All prompts live in lib/prompts.ts — never inline in API routes
4. next.config.js MUST stay as .js NOT .ts — never rename this file
5. Model string is ALWAYS claude-sonnet-4-6 — never change
6. temperature: 0 on ALL Anthropic API calls — never change
7. Use Claude Code for all file generation
8. Never let Claude Code run terminal commands — run them yourself
9. Never hardcode API keys — always use process.env.VARIABLE_NAME
10. Never commit .env.local — verify .gitignore before every push

## Deploy Sequence — ALWAYS RUN ALL 5 COMMANDS IN ORDER
*** Copy-paste these EXACTLY — do not skip any step ***
*** Run from inside the SpaceDebris directory ***

npm run build
git add .
git commit -m "your message here"
git push origin master:main --force
vercel --prod

*** If npm run build fails — FIX THE ERROR before running the other 4 commands ***
*** Never push broken code to production ***

## Known Technical Gotchas — Read Before Building
1. Space-Track session auth: cookie format is "chocolatechip=...; Path=/"
   Parse with: setCookie.split(';')[0]
   If getting 401s: set sessionCookie = null and force re-login

2. Three.js + React: always use useRef + useEffect pattern
   Never instantiate THREE objects outside useEffect
   Always clean up: cancelAnimationFrame, controls.dispose(), renderer.dispose()
   Always check if mountRef.current exists before accessing

3. OrbitControls import path (Next.js npm package):
   import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
   This works in Next.js — the React artifact warning about r128 does NOT apply here

4. satellite.js import in Next.js:
   import * as satellite from 'satellite.js'
   The package exports: twoline2satrec, propagate, gstime, eciToEcf, and more
   propagate() returns { position: {x,y,z}, velocity: {x,y,z} } in ECI km

5. D3 not rendering: check useEffect dependencies and SVG dimensions
   (D3 is kept as dependency but Three.js is used for OrbitalMap)

6. Claude returning inconsistent JSON: the prompts.ts already includes
   explicit JSON schema — if still failing, add "Return ONLY JSON" more prominently

7. Vercel build failing: check for missing env vars in Vercel dashboard first
   All three env vars must be set: ANTHROPIC_API_KEY, SPACETRACK_USERNAME, SPACETRACK_PASSWORD

8. next.config.js: never rename to .ts — Next.js requires .js extension for this file

9. Rate limiting Space-Track: in-memory caches already built in
   debris route: 10 minute cache
   conjunctions route: 60 second cache
   Do not hammer the API manually during testing

10. TypeScript strict mode is ON — never use 'any' type
    Always type API responses properly
    Check lib/prompts.ts for the exported TypeScript interfaces

## Git Repository
- GitHub: https://github.com/IQEmperor24/SpaceDebris.git
- Branch: main
- Remote: origin

## Vercel Deployment
- Connect GitHub repo to Vercel on first deploy
- Set all 3 env vars in Vercel dashboard BEFORE deploying
- vercel.json already sets maxDuration: 30s for analyze and conjunctions routes
- Custom domain: spacedebris.space (via GoDaddy — set up during hours 21-22)

## First Prompt To Give Claude Code (copy this exactly)
"Read CONTEXT.md in full before doing anything else.
Then generate these files completely, one at a time, in this order:
1. .gitignore
2. next.config.js
3. tsconfig.json
4. tailwind.config.js
5. postcss.config.js
6. package.json
7. app/globals.css
8. app/layout.tsx
Do not proceed to the next file until I confirm the current one is saved."

## Second Prompt (after foundations are confirmed working)
"Now generate app/page.tsx — the main dashboard layout with all 3 panels.
Use dynamic imports with ssr: false for all three components.
Show the full file top to bottom."

## Third Prompt (after page.tsx is saved)
"Now generate lib/anthropic.ts, lib/spacetrack.ts, and lib/prompts.ts
one at a time. Wait for my confirmation between each file."

## Fourth Prompt (after lib/ files are saved)
"Now generate the three API routes one at a time:
1. app/api/debris/route.ts
2. app/api/analyze/route.ts
3. app/api/conjunctions/route.ts
Wait for my confirmation between each file."

## Fifth Prompt (after API routes are saved)
"Now generate the three components one at a time:
1. components/RiskScorer.tsx
2. components/AlertFeed.tsx
3. components/OrbitalMap.tsx (Three.js 3D — save this for last, it's the biggest)
Wait for my confirmation between each file."

## Good Luck Aayush
You shipped SkinAI from zero to live product with real users.
SpaceDebris is the same architecture with a different domain.
You have already proven you can do this.
You are running on 3 hours of sleep — trust the process, follow the steps,
do not skip confirmations, and let Claude Code do the heavy lifting.
Houston, we have a solution. 🚀
