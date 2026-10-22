// Preloaded by `npm test`:
//   node --experimental-strip-types --import ./tests/register.mjs --test tests/*.test.ts
//
// 1. Registers the "@/" path-alias resolver (alias-hooks.mjs) so test files
//    and lib files can use the same imports as the Next.js app.
// 2. Disables the network. The suite is deterministic and must never reach
//    Space-Track, NOAA SWPC or Anthropic — CI has no credentials and no test
//    should depend on a live service. A test that needs HTTP behaviour
//    (tests/spacetrack.test.ts) installs its own fetch mock explicitly.
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);

globalThis.fetch = async (input) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input);
  throw new Error(`Network access is disabled in the test suite (attempted fetch: ${url})`);
};
