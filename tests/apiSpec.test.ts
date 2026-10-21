/* lib/apiSpec.ts — the single source for GET /api/openapi and the /docs page.
   These checks pin the public documentation to the real route handlers so a
   new route cannot ship undocumented and a documented route cannot go stale. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ENDPOINTS, API_RATE_LIMIT_PER_MINUTE, OPENAPI_SPEC } from "@/lib/apiSpec";
import { API_RATE_LIMIT, requestsPerMinute } from "@/lib/rateLimit";

const API_DIR = join(process.cwd(), "app", "api");
const routeDirs = readdirSync(API_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(API_DIR, d.name, "route.ts")))
  .map((d) => d.name)
  .sort();

test("every app/api/*/route.ts is documented, and every documented path exists", () => {
  const documented = new Set(API_ENDPOINTS.map((ep) => ep.path.replace(/^\/api\//, "")));
  for (const dir of routeDirs) assert.ok(documented.has(dir), `app/api/${dir} is not in API_ENDPOINTS`);
  for (const path of Array.from(documented)) {
    assert.ok(existsSync(join(API_DIR, path, "route.ts")), `${path} is documented but has no route.ts`);
  }
});

test("documented HTTP methods are exported by the route files", () => {
  for (const ep of API_ENDPOINTS) {
    const file = join(API_DIR, ep.path.replace(/^\/api\//, ""), "route.ts");
    const src = readFileSync(file, "utf8");
    assert.match(src, new RegExp(`export (async )?function ${ep.method}\\b`), `${ep.path} must export ${ep.method}`);
  }
});

test("endpoint ids are unique and every endpoint carries a curl, example and cost", () => {
  const ids = API_ENDPOINTS.map((ep) => ep.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate endpoint id");
  for (const ep of API_ENDPOINTS) {
    assert.ok(ep.curl.includes(ep.path), `${ep.id}: curl does not hit ${ep.path}`);
    assert.doesNotThrow(() => JSON.parse(ep.responseExample), `${ep.id}: responseExample is not JSON`);
    if (ep.method === "POST") {
      assert.ok(ep.requestExample, `${ep.id}: POST without a requestExample`);
      assert.doesNotThrow(() => JSON.parse(ep.requestExample!), `${ep.id}: requestExample is not JSON`);
    }
    assert.ok(["deterministic", "claude"].includes(ep.cost));
    assert.ok(ep.costEstimate.length > 0 && ep.cache.length > 0);
  }
});

test("OpenAPI document is 3.1 and has one path+method per endpoint", () => {
  assert.equal(OPENAPI_SPEC.openapi, "3.1.0");
  assert.ok(OPENAPI_SPEC.info.title.length > 0);
  for (const ep of API_ENDPOINTS) {
    const item = (OPENAPI_SPEC.paths as Record<string, Record<string, unknown>>)[ep.path];
    assert.ok(item, `${ep.path} missing from paths`);
    assert.ok(item[ep.method.toLowerCase()], `${ep.path} missing ${ep.method} operation`);
  }
  assert.equal(Object.keys(OPENAPI_SPEC.paths).length, new Set(API_ENDPOINTS.map((e) => e.path)).size);
});

test("published rate limit matches the middleware's token bucket", () => {
  assert.equal(API_RATE_LIMIT_PER_MINUTE, requestsPerMinute(API_RATE_LIMIT));
  assert.equal(API_RATE_LIMIT_PER_MINUTE, 120);
});
