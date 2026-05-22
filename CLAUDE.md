# SpaceDebris — Handoff Context File
# Generated at end of Session 1 due to image limit
# Read this ENTIRELY before responding to ANY prompt
# This is the continuation of an active Houston Hackathon build

---

## OPERATOR NOTE — CRITICAL
Aayush is operating on 3 hours of sleep during a 24-hour hackathon.
He is VERY prone to human error right now.
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

---

## Current Status — What Is Working RIGHT NOW

### ✅ FULLY WORKING
- App boots cleanly at localhost:3000
- npm run build — CLEAN, zero errors
- 3D Earth globe renders at 60 FPS with zone shell wireframes
- Background stars render correctly
- ALL/LEO/MEO/GEO filter buttons render
- AI Risk Scorer UI renders with all 5 quick-search chips
- Collision Alert Feed — FULLY WORKING WITH REAL DATA:
  - Fetches real CDMs from Space-Track.org
  - Claude summarizes them in plain English
  - Shows threat level badges (MEDIUM/HIGH/CRITICAL)
  - Auto-refresh countdown timer working
  - Real conjunction data showing (e.g. COSMOS 1275 DEB → CZ-6A DEB)
  - TCA, miss distance, probability all displaying correctly

### ❌ STILL BROKEN — NEEDS FIXING
1. **Orbital Map debris dots not loading** (0 objects shown)
   - Error: `Space-Track query failed: HTTP 404 Not Found`
   - URL: `class/tle_latest/orderby/EPOCH%20desc/limit/800/format/json`
   - Root cause: The full base URL prefix is missing
   - Correct URL must be: `https://www.space-track.org/basicspacedata/query/class/tle_latest/orderby/EPOCH%20desc/limit/800/format/json`
   - File to fix: `lib/spacetrack.ts` — `fetchTLEs` function

2. **ISS Risk Scorer failing** (clicking ISS chip returns error)
   - Error: `Space-Track query failed: HTTP 404 Not Found`
   - URL: `class/tle_latest/OBJECT_NAME/~~ISS/orderby/EPOCH%20desc/limit/1/format/json`
   - Root cause: Same missing base URL prefix issue
   - File to fix: `lib/spacetrack.ts` — `searchTLE` function

### THE FIX NEEDED RIGHT NOW
Both `fetchTLEs` and `searchTLE` in `lib/spacetrack.ts` are building
URLs without the full `https://www.space-track.org/basicspacedata/query/`
prefix. The `QUERY_BASE` constant exists but is not being concatenated
correctly into the final URL strings.

The focused Claude Code prompt to use:
```
Error in lib/spacetrack.ts only.
Both fetchTLEs and searchTLE are returning 404 because the Space-Track
query paths are missing the full base URL prefix.

The errors are:
1. class/tle_latest/orderby/EPOCH%20desc/limit/800/format/json → 404
2. class/tle_latest/OBJECT_NAME/~~ISS/orderby/EPOCH%20desc/limit/1/format/json → 404

The correct full URLs must start with:
https://www.space-track.org/basicspacedata/query/

Check how QUERY_BASE is defined and how it is concatenated in fetchTLEs
and searchTLE. The final URLs hitting Space-Track must be complete
absolute URLs starting with:
https://www.space-track.org/basicspacedata/query/class/...

Only look at lib/spacetrack.ts. Show complete fixed file top to bottom.
Do not read any other files.
```

---

## Project Overview
SpaceDebris — AI-powered real-time space debris collision risk dashboard
Built solo in 24 hours for Houston Hackathon
Judging criteria: Real-world impact

### The Pitch
"27,000 pieces of debris orbit Earth right now. One collision can trigger
Kessler Syndrome — a chain reaction that makes all orbits unusable forever,
killing GPS, internet, and weather satellites. I built a real-time AI risk
dashboard that scores collision threats and recommends avoidance maneuvers
using live Space-Track.org data."

### Hackathon Tracks Entered
- General Track (primary)
- Best Use of AI (side challenge)
- Best Solo Hack (side challenge — Raspberry Pi 5 Kit prize)

---

## Tech Stack
- Next.js 14.2.3 App Router
- TypeScript (strict mode ON)
- Tailwind CSS
- Three.js (3D orbital visualization)
- satellite.js (SGP4 TLE propagation)
- Anthropic Claude via API — model: `claude-sonnet-4-6`
- Space-Track.org API (live TLE + CDM data)
- Vercel (deployment)

---

## Complete File Structure — ALL FILES GENERATED AND WORKING
```
C:\Users\user\SpaceDebris\
├── .env.local                    ✅ Created with real API keys
├── .gitignore                    ✅ Complete
├── CONTEXT.md                    ✅ Updated (model string fixed)
├── HANDOFF.md                    ← This file
├── PROMPT_SEQUENCE.md            ✅ Full 32-prompt build sequence
├── next.config.js                ✅ Stays as .js NOT .ts
├── tsconfig.json                 ✅ Strict mode, @/* alias
├── tailwind.config.js            ✅ Space theme colors
├── postcss.config.js             ✅ Tailwind pipeline
├── package.json                  ✅ All deps, @types/satellite.js REMOVED
├── next-env.d.ts                 ✅ Auto-generated by Next.js
├── package-lock.json             ✅ Generated by npm install
├── node_modules/                 ✅ Installed
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
│   ├── spacetrack.ts             ⚠️  NEEDS URL FIX (see above)
│   └── prompts.ts                ✅ All Claude prompts + shared types
└── components/
    ├── OrbitalMap.tsx            ✅ Three.js 3D — OrbitControls.js fix applied
    ├── RiskScorer.tsx            ✅ AI risk scoring UI
    └── AlertFeed.tsx             ✅ Live conjunction feed — WORKING
```

---

## Environment Variables — .env.local
```
ANTHROPIC_API_KEY=<from SkinAI project>
SPACETRACK_USERNAME=a2khazan@uwaterloo.ca
SPACETRACK_PASSWORD=<set during Space-Track registration>
```
File location: `C:\Users\user\SpaceDebris\.env.local`
File size: 215 bytes ✅

---

## Key Fixes Already Applied This Session
1. `@types/satellite.js` removed from package.json (doesn't exist on npm)
2. `OrbitControls` import changed to `OrbitControls.js` (Three.js bundler fix)
3. `CLAUDE_MODEL` changed from `claude-sonnet-4-20250514` to `claude-sonnet-4-6`
4. `fetchTLEs` — removed `ORDINAL/1` from URL path
5. `searchTLE` — removed `ORDINAL/1` from URL path
6. CONTEXT.md updated to reflect `claude-sonnet-4-6` in all 3 places

---

## What Still Needs To Be Done (Remaining Phases)

### IMMEDIATE — Fix lib/spacetrack.ts URL issue (see above)
This is the #1 priority. Once fixed, the orbital map will show debris dots
and the ISS risk scorer will work.

### Phase 6 — Full smoke test after URL fix
After fixing spacetrack.ts:
1. Restart npm run dev
2. Verify orbital map shows debris dots (should show ~800 objects)
3. Click ISS chip — verify risk score returns
4. Verify collision alert feed still working
5. Run npm run build — must be clean before deploy

### Phase 7 — Sponsor Integrations (prize tracks)
Priority order for maximum prize impact:
1. **ElevenLabs** — voice-read CRITICAL alerts (highest demo impact)
2. **MongoDB Atlas** — persist risk scores, replace in-memory caches
3. **GoDaddy** — register spacedebris.space domain
4. **Snowflake** — historical risk score warehouse panel
5. **Solana** — on-chain log of CRITICAL events
6. **Gemini** — dual-AI consensus scoring

### Phase 8 — Deploy to Vercel
Deploy sequence (ALL 5 commands, in order):
```bash
npm run build
git add .
git commit -m "feat: SpaceDebris MVP complete"
git push origin main
vercel --prod
```
⚠️ IMPORTANT: Before deploying, add all 3 env vars to Vercel dashboard:
- ANTHROPIC_API_KEY
- SPACETRACK_USERNAME
- SPACETRACK_PASSWORD

---

## Critical Rules — NEVER VIOLATE
1. FULL FILES ONLY — never partial files or isolated code blocks
2. npm run build before every deploy
3. All prompts in lib/prompts.ts — never inline
4. next.config.js stays as .js NOT .ts
5. Model string is claude-sonnet-4-6
6. temperature: 0 on all Claude API calls
7. Never commit .env.local
8. Never let Claude Code run terminal commands — Aayush runs them
9. Never hardcode API keys
10. For debug prompts: always specify exact file, do not read others

---

## Debug Prompt Template — USE THIS EVERY TIME
```
Error in [EXACT FILE] at line [N]:
[PASTE EXACT ERROR]
Only look at [EXACT FILE].
Fix by [EXACT FIX IF KNOWN].
Show complete fixed file top to bottom.
Do not read any other files.
```

---

## Space-Track.org API — Key Facts
- Aayush is logged in as: a2khazan@uwaterloo.ca
- Session cookie auth — cookie cached 50 minutes
- Cookie parse: setCookie.split(';')[0]
- Rate limit: 30 req/min, 300/hr
- Base URL: https://www.space-track.org
- Login: POST https://www.space-track.org/ajaxauth/login
- Query base: https://www.space-track.org/basicspacedata/query/
- TLE endpoint: /class/tle_latest/
- CDM endpoint: /class/cdm_public/

---

## Three.js Architecture — DO NOT CHANGE THESE
- THREE.Points (one draw call for all debris)
- Custom ShaderMaterial with additive blending + circular falloff
- Log-scale altitude: scene_r = 1.0 + Math.log1p(altKm / 2000) * 1.4
- ECI→ECF→Three.js axis mapping: ECF.x→Three.x, ECF.z→Three.y, ECF.y→Three.-z
- OrbitControls from 'three/examples/jsm/controls/OrbitControls.js' (with .js)
- Full cleanup on unmount: cancelAnimationFrame + controls.dispose() + renderer.dispose()

---

## Winning Demo Flow (3 minutes)
1. Open dashboard — judges see 3D Earth globe auto-rotating
2. Say: "Every dot is a real object. Its position is computed right now
   from live TLE data via satellite.js SGP4 propagation."
3. Click ISS chip — get live AI risk report in ~10 seconds
4. Show collision alert feed auto-updating with real CDM data
5. Drop Kessler Syndrome explanation:
   "One collision cascades into thousands. GPS goes dark.
   Weather forecasting stops. Internet satellites fall.
   This dashboard exists to prevent that."
6. Close: "I shipped a consumer AI product last week with real paying users.
   I built this in 24 hours, alone. Imagine what 6 months looks like."

---

## Git Repository
- GitHub: https://github.com/IQEmperor24/SpaceDebris.git
- Branch: main
- Local path: C:\Users\user\SpaceDebris

## Claude Code Setup
- Tool: Claude Code CLI (terminal, not web)
- Launch: cd C:\Users\user\SpaceDebris && claude
- Model: Opus 4.7 1M context
- Session cost so far: ~$3-4
- Context used: ~8%

## Token Efficiency Rules Learned This Session
- Always specify exact file in debug prompts
- Add "Do not read any other files" to every debug prompt
- Simple one-line fixes (model strings, config values) = edit manually in Notepad
- Reserve Opus for: complex logic, new files, multi-file coordinated changes
- Use /cost in Claude Code to check token burn

---

## Good Luck Aayush
The Collision Alert Feed is showing REAL live conjunction data from Space-Track.
Claude is summarizing real government orbital warnings in plain English.
The 3D globe is rendering at 60 FPS.
You are ONE bug fix away from a fully working MVP.

Fix lib/spacetrack.ts, get those debris dots on the globe,
test ISS risk scorer, then DEPLOY and WIN.

Houston, we have a solution. 🚀
