import Anthropic from "@anthropic-ai/sdk";

/* ============================================================
   SpaceDebris — Anthropic client singleton

   Single source of truth for:
   - The model string (Workflow Rule #5).
   - The default temperature (Workflow Rule #6).
   - Reading the API key from the environment (Workflow Rule #9).

   API routes should import getAnthropic(), CLAUDE_MODEL, and
   DEFAULT_TEMPERATURE from here — never re-declare them inline.
   ============================================================ */

/**
 * The ONLY model string used anywhere in SpaceDebris.
 * Single source of truth — change it here and nowhere else.
 *
 * NOTE: CONTEXT.md Workflow Rule #5 originally pinned this to
 * "claude-sonnet-4-20250514", but that snapshot now returns 404
 * (retired). Updated to the current Sonnet 4.6 model string.
 */
export const CLAUDE_MODEL = "claude-sonnet-4-6" as const;

/**
 * Temperature for ALL Anthropic calls.
 * *** Always 0 — see CONTEXT.md Workflow Rule #6. ***
 */
export const DEFAULT_TEMPERATURE = 0 as const;

/**
 * Cache the client on globalThis so Next.js hot-reload in dev
 * does not spawn a new Anthropic client on every file change.
 */
const globalForAnthropic = globalThis as unknown as {
  anthropic: Anthropic | undefined;
};

/**
 * Lazily create (and cache) the Anthropic client.
 *
 * Lazy on purpose: instantiating at module load would throw at
 * build time if ANTHROPIC_API_KEY is not set. This way the build
 * stays green and we only require the key when Claude is called.
 */
export function getAnthropic(): Anthropic {
  if (globalForAnthropic.anthropic) {
    return globalForAnthropic.anthropic;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (local) and to the Vercel dashboard (production)."
    );
  }

  const client = new Anthropic({ apiKey });
  globalForAnthropic.anthropic = client;
  return client;
}
