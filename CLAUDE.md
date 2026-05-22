SpaceDebris — CLAUDE.md
Holy Grail Context File for Claude Code (Opus)
READ THIS ENTIRELY BEFORE RESPONDING TO ANY PROMPT
Last updated: End of Session 2 — Houston Hackathon

OPERATOR NOTE — CRITICAL
Aayush is a Waterloo CS grad building SpaceDebris solo in 24 hours.
He is sleep-deprived and prone to human error.
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


Project Overview
SpaceDebris — AI-powered real-time space debris collision risk dashboard
Built solo in 24 hours for Houston Hackathon
Judging criteria: Real-world impact
The Pitch
"27,000 pieces of debris orbit Earth right now. SpaceX's Starlink alone
performed 300,000 collision avoidance maneuvers in 2025 — a 50% increase
over 2024. One collision can trigger Kessler Syndrome — a chain reaction
that makes all orbits unusable forever, killing GPS, internet, and weather
satellites. I built a real-time AI risk dashboard that scores collision
threats using live Space-Track.org government data."
Hackathon Tracks Entered

General Track (primary)
Best Use of AI (side challenge)
Best Solo Hack (side challenge — Raspberry Pi 5 Kit prize)


Live Deployment

URL: https://space-debris-two.vercel.app
Vercel Authentication: DISABLED (fully public, no login required)
GitHub: https://github.com/IQEmperor24/SpaceDebris.git
Branch: main
Last commit: 5740f4e — "feat: counter shows filtered/total, 2000 debris objects"
Auto-deploys on every git push origin main (GitHub webhook connected)
vercel --prod CLI NOT needed — push to GitHub = auto deploy


Tech Stack

Next.js 14.2.3 App Router
TypeScript (strict mode ON)
Tailwind CSS
Three.js (3D orbital visualization)
satellite.js (SGP4 TLE propagation)
Anthropic Claude via API — model: claude-sonnet-4-6
Space-Track.org API (live TLE + CDM data)
Vercel (deployment, Hobby plan)


Current Status — What Is Working RIGHT NOW
✅ FULLY WORKING (as of Session 2)

App boots cleanly at localhost:3000
npm run build — CLEAN, zero errors
3D Earth globe renders at 47-60 FPS
Background stars render correctly
ALL/LEO/MEO/GEO filter buttons render and filter correctly
Object counter shows filtered/total (e.g. "1612 / 1973 objects")
~1,973 debris objects loading from Space-Track gp class
AI Risk Scorer UI renders with all 5 quick-search chips
ISS chip — WORKING, returns real AI risk score
Collision Alert Feed — FULLY WORKING WITH REAL DATA:

Fetches real CDMs from Space-Track.org
Claude summarizes them in plain English
Shows threat level badges (LOW/MEDIUM/HIGH/CRITICAL)
Auto-refresh countdown timer working
Real conjunction data showing
TCA, miss distance, probability all displaying correctly


Deployed live at space-debris-two.vercel.app
Vercel public access enabled (no login required)
vercel.json generated (sets function timeouts)
GitHub connected to Vercel (auto-deploy on push)

❌ KNOWN ISSUES (not fixed, acceptable for demo)

Debris objects render as glowing blobs on desktop (shader additive
blending stacks dots visually — scientifically accurate clustering
but not individual visible dots). DO NOT FIX — too risky, low reward.
Mobile rendering: dots not visible on phone screens (WebGL shader
limitation). DO NOT FIX — judges will demo on desktop.
Object count shows ~1,973 not 2,000 — normal, Space-Track drops
objects with invalid/stale TLEs. Not a bug.

⏳ NICE TO HAVE (if time permits)

ElevenLabs voice alerts for CRITICAL conjunctions (~45 min, sponsor prize)
Polish debris dot colors (currently green glow, could be amber/white)


Complete File Structure
C:\Users\user\SpaceDebris\
├── .env.local                    ✅ Real API keys (NEVER commit this)
├── .gitignore                    ✅ Covers .env.local and node_modules
├── CLAUDE.md                     ✅ This file — Claude Code's rulebook
├── vercel.json                   ✅ Generated Session 2 (function timeouts)
├── next.config.js                ✅ Stays as .js NOT .ts — never rename
├── tsconfig.json                 ✅ Strict mode, @/* alias
├── tailwind.config.js            ✅ Space theme colors
├── postcss.config.js             ✅ Tailwind pipeline
├── package.json                  ✅ All deps, @types/satellite.js REMOVED
├── package-lock.json             ✅ Do not edit manually
├── node_modules/                 ✅ Installed, gitignored
├── app/
│   ├── globals.css               ✅ Full space theme + animations
│   ├── layout.tsx                ✅ Syne + Syne Mono fonts
│   ├── page.tsx                  ✅ 3-panel dashboard, dynamic imports
│   └── api/
│       ├── debris/route.ts       ✅ TLE fetch, 10-min cache
│       ├── analyze/route.ts      ✅ Claude risk scoring
│       └── conjunctions/route.ts ✅ CDM alerts, 60s cache — WORKING
├── lib/
│   ├── anthropic.ts              ✅ Model: claude-sonnet-4-6
│   ├── spacetrack.ts             ✅ FIXED Session 2 — see fixes below
│   └── prompts.ts                ✅ All Claude prompts + shared types
└── components/
    ├── OrbitalMap.tsx            ✅ FIXED Session 2 — see fixes below
    ├── RiskScorer.tsx            ✅ AI risk scoring UI
    └── AlertFeed.tsx             ✅ Live conjunction feed — WORKING

Environment Variables — .env.local
ANTHROPIC_API_KEY=<from SkinAI project>
SPACETRACK_USERNAME=a2khazan@uwaterloo.ca
SPACETRACK_PASSWORD=<set during Space-Track registration>
File location: C:\Users\user\SpaceDebris.env.local
⚠️ NEVER commit this file. It is in .gitignore. Verify with git status.
⚠️ These same 3 vars are set in Vercel dashboard → Settings → Environment Variables

ALL Fixes Applied — Sessions 1 + 2
Session 1 Fixes

@types/satellite.js removed from package.json (doesn't exist on npm)
OrbitControls import changed to OrbitControls.js (Three.js bundler fix)
CLAUDE_MODEL changed to claude-sonnet-4-6
fetchTLEs — removed ORDINAL/1 from URL path
searchTLE — removed ORDINAL/1 from URL path

Session 2 Fixes

lib/spacetrack.ts — changed tle_latest → gp class in fetchTLEs

Root cause: tle_latest class returns HTTP 404 even with valid auth
Space-Track deprecated tle_latest, gp is the current standard
Auth was NEVER broken — login returns HTTP 200, cookie confirmed
Cookie name: chocolatechip (this is correct, not a bug)


lib/spacetrack.ts — changed tle_latest → gp class in searchTLE

Same root cause as above


lib/spacetrack.ts — improved error message to show full URL not queryPath
lib/spacetrack.ts — added then removed diagnostic console.logs

Logs confirmed: login HTTP 200, cookie present, auth working perfectly
Logs removed before deploy (cookie fragments in server logs = security smell)


components/OrbitalMap.tsx — DEBRIS_LIMIT changed from 800 to 2000

Actual objects returned: ~1,973 (Space-Track drops invalid TLEs)
Performance tested by Opus: 2000 = ~80-200ms freeze on load (acceptable)
3000+ would cause visible stutter — do not increase further


components/OrbitalMap.tsx — object counter fixed

Now shows filtered/total (e.g. "1612 / 1973 objects")
Previously always showed total regardless of filter
count state = filtered/visible, total state = set once on load


vercel.json — generated (function timeout configuration)
.next cache — cleared once during Session 2 (rmdir /s /q .next)

Safe to do anytime, rebuilds automatically on npm run dev




Space-Track.org API — Critical Facts

Username: a2khazan@uwaterloo.ca
Auth: session cookie (valid ~50 min, auto-refreshed in spacetrack.ts)
Cookie name: chocolatechip (Space-Track's actual cookie name, not a bug)
Cookie parse: setCookie.split(';')[0]
Rate limit: 30 req/min, 300/hr
Base URL: https://www.space-track.org
Login: POST https://www.space-track.org/ajaxauth/login
Query base: https://www.space-track.org/basicspacedata/query/
TLE endpoint: class/gp/ (NOT tle_latest — that returns 404)
CDM endpoint: class/cdm_public/ (working, do not touch)
Space-Track returns 404 (not 401) for unauthenticated requests


Three.js Architecture — DO NOT CHANGE THESE

THREE.Points (one draw call for all debris)
Custom ShaderMaterial with additive blending + circular falloff
Log-scale altitude: scene_r = 1.0 + Math.log1p(altKm / 2000) * 1.4
ECI→ECF→Three.js axis mapping: ECF.x→Three.x, ECF.z→Three.y, ECF.y→Three.-z
OrbitControls from 'three/examples/jsm/controls/OrbitControls.js' (with .js)
Full cleanup on unmount: cancelAnimationFrame + controls.dispose() + renderer.dispose()
DEBRIS_LIMIT = 2000 (do not increase without performance testing)
Propagation cost: ~40-100μs per object on hackathon laptops
2000 objects = ~80-200ms load freeze (acceptable)
3000+ objects = visible stutter (do not go there)


What The Filters Show (for demo context)

ALL: Every tracked object across all orbital bands
LEO (200-2000km): Densest band, ISS, all Starlink, most debris

Shows as bright dense cluster close to Earth — correct
~1,612 of 1,973 total objects


MEO (2000-35786km): GPS constellation, Galileo, GLONASS

Shows as 6 distinct clusters — correct (GPS orbital planes)
~327 of 1,973 total objects


GEO (35,786km): Weather sats, TV broadcast, military surveillance

Shows as equatorial ring — correct (geostationary belt)
~34 of 1,973 total objects




Anthropic API Cost Reality Check

Model: claude-sonnet-4-6
Cost: $3.00 input / $15.00 output per million tokens
Per ISS risk score call: ~$0.006
Per CDM summary: ~$0.004
500 judge interactions = ~$3 total
API key will NOT burn out during hackathon — stop worrying about it


Deploy Sequence — ALL 3 COMMANDS, IN ORDER
⚠️ Run these in second terminal (NOT in Claude Code)
⚠️ Never use --force on git push
⚠️ Vercel auto-deploys after git push — vercel --prod NOT needed
bashgit add .
git commit -m "your message here"
git push origin main
Wait 60-90 seconds → Vercel auto-deploys → check space-debris-two.vercel.app
Pre-Deploy Checklist

npm run build must be CLEAN (zero errors) — run it first
.env.local must NOT appear in git status
node_modules must NOT appear in git status
Check Vercel dashboard env vars match .env.local


Critical Rules — NEVER VIOLATE

FULL FILES ONLY — never partial files or isolated code blocks
npm run build before every deploy
All prompts in lib/prompts.ts — never inline
next.config.js stays as .js NOT .ts
Model string is claude-sonnet-4-6
temperature: 0 on all Claude API calls
Never commit .env.local
Never let Claude Code run terminal commands — Aayush runs them
Never hardcode API keys
For debug prompts: always specify exact file, do not read others
Never use --force on git push
TLE endpoint is class/gp NOT class/tle_latest (tle_latest = 404)


Debug Prompt Template — USE THIS EVERY TIME
Error in [EXACT FILE] at line [N]:
[PASTE EXACT ERROR]
Only look at [EXACT FILE].
Fix by [EXACT FIX IF KNOWN].
Show complete fixed file top to bottom.
Do not read any other files.

Claude Code Operational Notes (learned Session 2)

Claude Code auto-applies file edits — ✓ checkmark = file written to disk
Multi-line pastes need double Ctrl+V (paste again to expand)
For long prompts that trigger paste-expand: use single-line prompts
"accept edits on (shift+tab to cycle)" = edits are PENDING, press Enter
Claude Code reads CLAUDE.md automatically as its rulebook
Claude Code cannot run terminal commands — it can only edit files
Claude Code has NO memory between sessions — CLAUDE.md IS the memory
Restart sequence: cd C:\Users\user\SpaceDebris && claude
First prompt after restart: "Read CLAUDE.md entirely before responding"


Session 2 Lessons Learned (mistakes made)

Initial diagnosis was wrong — thought URL prefix was missing

Real issue: tle_latest class deprecated, not URL construction
Opus correctly pushed back and was right to do so


Told Aayush to exit Claude Code to clear cache — WRONG

Never exit Claude Code, use second terminal for npm commands
.next cache cleared with: rmdir /s /q .next (in second terminal)


Suggested limit/10000 — Opus correctly flagged performance risk

10000 objects = ~400-1000ms freeze = visible hang during demo
Final choice: 2000 objects (safe, impressive, smooth)


Multi-line prompt paste caused "es.es.es..." input glitch

Fix: use single-line prompts in Claude Code


Deployed to Vercel before pushing code to GitHub

Vercel pulled old commit (aca6d77) with missing Next.js in deps
Fix: always git push before expecting Vercel to have new code




Winning Demo Flow (3 minutes)

Open dashboard — judges see 3D Earth globe auto-rotating
Say: "Every dot is a real object tracked by the US Space Force.
Its position is computed right now using live TLE data via
satellite.js SGP4 propagation."
Click LEO filter — show "1,612 objects in Low Earth Orbit"
"This is where Starlink lives. SpaceX performed 300,000 collision
avoidance maneuvers here in 2025 alone — a 50% increase over 2024."
Click MEO — show GPS clusters
"Those 6 clusters are the GPS constellation. One Kessler cascade
here and navigation goes dark globally."
Click GEO — show equatorial ring
"That ring is where your weather forecasts come from. Debris here
doesn't deorbit for thousands of years."
Click ISS chip — get live AI risk report in ~10 seconds
"This is a live AI assessment of the ISS collision risk right now."
Show collision alert feed
"These are real government conjunction warnings from Space-Track.org,
summarized by Claude AI in plain English."
Close: "27,000 pieces of debris. One collision cascades into thousands.
GPS goes dark. Weather forecasting stops. I built the dashboard that
monitors it all in 24 hours, alone. Imagine what 6 months looks like."


Git Repository

GitHub: https://github.com/IQEmperor24/SpaceDebris.git
Branch: main
Local path: C:\Users\user\SpaceDebris
Last commit: 5740f4e

Claude Code Setup

Tool: Claude Code CLI (terminal)
Launch: cd C:\Users\user\SpaceDebris && claude
Model: Opus (latest)
First prompt every session:
"Read CLAUDE.md entirely before responding to anything.
Confirm you have read it by summarizing current status,
what is broken, and what was fixed last session.
Do not read any other files until you confirm this."


Good Luck Aayush
Session 2 complete. Here is what you shipped:

Fixed the Space-Track TLE endpoint (tle_latest → gp)
Diagnosed and confirmed auth working (chocolatechip cookie, HTTP 200)
Increased debris objects from 800 to 1,973
Fixed orbital filter counter (shows filtered/total)
Generated vercel.json
Deployed live to space-debris-two.vercel.app
Made deployment fully public (no login required)
GitHub auto-deploy pipeline connected and working

The app is live. The data is real. The AI is working.
Go sleep. Come back fresh. Win the hackathon.
Houston, we have a solution. 🚀