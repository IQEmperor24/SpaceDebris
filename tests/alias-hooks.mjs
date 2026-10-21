// Node module-resolution hook used by the test suite (see register.mjs).
//
// Lets `node --experimental-strip-types` run the repo's TypeScript lib files
// directly, with no bundler and no test-framework dependency:
//   - maps the Next.js / tsconfig path alias "@/<path>" to <repo root>/<path>
//   - appends ".ts" / ".tsx" to extensionless relative or aliased imports
//     (TypeScript source omits extensions; Node's ESM resolver requires them)
//   - tags the repo's own .ts files as ES modules ("module-typescript"), so
//     Node does not first try them as CommonJS and print a
//     MODULE_TYPELESS_PACKAGE_JSON warning per file (the root package.json
//     cannot declare "type": "module": next.config.js is CommonJS)
//
// The repo root is derived from THIS file's location (tests/..), so the hook
// works from any working directory, on Linux CI and on Windows alike.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Add a TypeScript extension when the specifier names an extensionless file. */
function withExtension(absPath) {
  if (/\.[cm]?[jt]sx?$/.test(absPath) || absPath.endsWith(".json")) return absPath;
  for (const ext of [".ts", ".tsx"]) {
    if (existsSync(absPath + ext)) return absPath + ext;
  }
  // "@/lib/foo" where foo is a directory with an index file.
  if (existsSync(absPath) && statSync(absPath).isDirectory()) {
    for (const index of ["index.ts", "index.tsx"]) {
      const candidate = path.join(absPath, index);
      if (existsSync(candidate)) return candidate;
    }
  }
  return absPath;
}

const REPO_URL = pathToFileURL(REPO_ROOT + path.sep).href;
const NODE_MODULES_URL = pathToFileURL(path.join(REPO_ROOT, "node_modules") + path.sep).href;
// Type stripping is built in from Node 22.6 (flagged) / 22.18 (default).
const CAN_STRIP_TYPES = Boolean(process.features && process.features.typescript);

/** Repo-owned .ts sources are always ES modules; say so instead of letting Node guess. */
function withFormat(result) {
  if (
    CAN_STRIP_TYPES &&
    result.format == null &&
    result.url.endsWith(".ts") &&
    result.url.startsWith(REPO_URL) &&
    !result.url.startsWith(NODE_MODULES_URL)
  ) {
    return { ...result, format: "module-typescript" };
  }
  return result;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const mapped = withExtension(path.join(REPO_ROOT, specifier.slice(2)));
    return withFormat(await nextResolve(pathToFileURL(mapped).href, context));
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    typeof context.parentURL === "string" &&
    context.parentURL.startsWith("file:")
  ) {
    const abs = fileURLToPath(new URL(specifier, context.parentURL));
    const mapped = withExtension(abs);
    if (mapped !== abs) return withFormat(await nextResolve(pathToFileURL(mapped).href, context));
  }
  return withFormat(await nextResolve(specifier, context));
}
