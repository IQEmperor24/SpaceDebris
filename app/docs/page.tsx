import type { Metadata } from "next";
import {
  API_BASE_URL,
  API_COST_COUNTS,
  API_DISCLAIMER,
  API_ENDPOINTS,
  API_EXPENSIVE_RATE_LIMIT_PER_MINUTE,
  API_RATE_LIMIT_PER_MINUTE,
  API_VERSION,
  CORS_POLICY,
  RATE_LIMIT_POLICY,
  costSummary,
  type ApiEndpoint,
  type ApiMethod,
  type ApiParam,
} from "@/lib/apiSpec";
import { API_EXPENSIVE_RATE_LIMIT, API_RATE_LIMIT } from "@/lib/rateLimit";

/* ============================================================
   /docs — SpaceDebris public API reference (Session 6, Feature 5)

   SERVER COMPONENT (no "use client"): rendered to static HTML at
   build time with zero client JS beyond Next's own runtime. All
   content comes from lib/apiSpec.ts — the same endpoint list that
   GET /api/openapi turns into the OpenAPI 3.1 document — so this
   page and the machine-readable spec can never disagree.

   Layout: title + intro + links, three policy cards (rate limit,
   CORS, cost), an endpoint index, then one card per endpoint
   grouped by tag (method badge, path, summary, params table, curl,
   illustrative response example, cost / cache / upstream chips).

   ASSUMPTIONS printed in the footnote:
   - Response examples are illustrative and abbreviated.
   - The rate limits (general + expensive tier) are enforced per Edge
     instance (best-effort).
   - Claude costs are the project's own per-call estimates.
   - Results are estimates on public data, not operational CA.
   ============================================================ */

export const metadata: Metadata = {
  title: "SpaceDebris API",
  description:
    "Public SpaceDebris REST API: Space-Track catalog sample, deterministic SGP4 conjunction screening, launch COLA, ISS, space weather and Claude-backed assessments.",
};

const METHOD_COLORS: Record<ApiMethod, string> = {
  GET: "#00FF41",
  POST: "#FFB800",
};

const CLAUDE_COLOR = "#FFB800";

const LABEL = "font-mono text-[0.6rem] uppercase tracking-widest text-text-muted";
const PRE =
  "font-mono text-[0.7rem] leading-relaxed bg-black/40 rounded-md p-3 overflow-x-auto text-text-primary";
const LINK =
  "rounded border border-glass bg-white/5 px-2 py-1 font-mono text-[0.65rem] tracking-wide text-text-secondary transition-colors hover:text-text-primary";

/** Group endpoints by tag, preserving catalogue order. */
function groupByTag(endpoints: ReadonlyArray<ApiEndpoint>): Array<{ tag: string; items: ApiEndpoint[] }> {
  const groups: Array<{ tag: string; items: ApiEndpoint[] }> = [];
  for (const ep of endpoints) {
    const existing = groups.find((g) => g.tag === ep.tag);
    if (existing) existing.items.push(ep);
    else groups.push({ tag: ep.tag, items: [ep] });
  }
  return groups;
}

function MethodBadge({ method }: { method: ApiMethod }) {
  const color = METHOD_COLORS[method];
  return (
    <span
      className="inline-block shrink-0 rounded border px-1.5 py-0.5 font-display text-[0.6rem] font-bold tracking-widest"
      style={{ color, borderColor: color, backgroundColor: `${color}14` }}
    >
      {method}
    </span>
  );
}

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  if (color) {
    return (
      <span
        className="inline-block rounded border px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide"
        style={{ color, borderColor: `${color}99`, backgroundColor: `${color}14` }}
      >
        {children}
      </span>
    );
  }
  return (
    <span className="inline-block rounded border border-glass bg-white/5 px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wide text-text-secondary">
      {children}
    </span>
  );
}

/** Render `backtick` spans (Markdown in the OpenAPI text) as inline code. */
function RichText({ text }: { text: string }) {
  const parts = text.split("`");
  // An unmatched backtick leaves an even number of parts: render verbatim.
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-white/5 px-1 font-mono text-[0.95em] text-text-primary">
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function ParamConstraints({ param }: { param: ApiParam }) {
  const parts: string[] = [];
  if (param.enum && param.enum.length > 0) parts.push(`one of ${param.enum.join(" · ")}`);
  if (param.default !== undefined) parts.push(`default ${param.default}`);
  if (param.maxLength !== undefined) parts.push(`max ${param.maxLength} chars`);
  if (param.format !== undefined) parts.push(`format ${param.format}`);
  if (param.example !== undefined) parts.push(`e.g. ${param.example}`);
  if (parts.length === 0) return null;
  return <div className="mt-1 font-mono text-[0.6rem] text-text-muted">{parts.join(" — ")}</div>;
}

function ParamsTable({ params }: { params: ApiParam[] }) {
  if (params.length === 0) {
    return <p className="font-mono text-xs text-text-secondary">No parameters.</p>;
  }
  return (
    <>
      {/* Phones: stacked list (no sideways scrolling). */}
      <ul className="space-y-2 sm:hidden">
        {params.map((p) => (
          <li key={`${p.in}:${p.name}`} className="rounded-md border border-glass bg-white/5 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs text-text-primary">{p.name}</span>
              <span className="font-mono text-[0.6rem] text-text-secondary">
                {p.in} · {p.type}
              </span>
              <span className={`font-mono text-[0.6rem] ${p.required ? "text-text-primary" : "text-text-muted"}`}>
                {p.required ? "required" : "optional"}
              </span>
            </div>
            <div className="mt-1 text-xs leading-relaxed text-text-secondary">
              <RichText text={p.description} />
            </div>
            <ParamConstraints param={p} />
          </li>
        ))}
      </ul>
      {/* sm and up: table. */}
      <div className="hidden overflow-x-auto rounded-md border border-glass sm:block">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-glass bg-white/5">
              {["Name", "In", "Type", "Required", "Description"].map((h) => (
                <th key={h} className={`px-3 py-2 font-normal ${LABEL}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {params.map((p) => (
              <tr key={`${p.in}:${p.name}`} className="border-b border-glass align-top last:border-b-0">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-text-primary">{p.name}</td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">{p.in}</td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">{p.type}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {p.required ? (
                    <span className="text-text-primary">yes</span>
                  ) : (
                    <span className="text-text-muted">no</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs leading-relaxed text-text-secondary">
                  <RichText text={p.description} />
                  <ParamConstraints param={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EndpointCard({ ep }: { ep: ApiEndpoint }) {
  return (
    <section
      id={ep.id}
      data-testid="api-endpoint"
      data-endpoint-id={ep.id}
      className="glass-card scroll-mt-4 overflow-hidden"
    >
      <div className="flex h-9 items-center justify-between gap-3 border-b border-glass px-3">
        <div className="flex min-w-0 items-center gap-2">
          <MethodBadge method={ep.method} />
          <h3 className="truncate font-mono text-xs text-text-primary">{ep.path}</h3>
        </div>
        <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
          {ep.cost === "claude" ? "Claude" : "Deterministic"}
        </span>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <p className="font-display text-sm font-semibold text-text-primary">{ep.summary}</p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            <RichText text={ep.description} />
          </p>
        </div>

        <div>
          <div className="flex flex-wrap gap-2">
            {ep.cost === "claude" ? (
              <Chip color={CLAUDE_COLOR}>Claude · {ep.costEstimate}</Chip>
            ) : (
              <Chip>Deterministic · {ep.costEstimate}</Chip>
            )}
            <Chip>Cache · {ep.cache}</Chip>
            <Chip color={ep.rateLimit.tier === "expensive" ? CLAUDE_COLOR : undefined}>
              Rate limit · {ep.rateLimit.tier === "expensive" ? "expensive tier" : "general"} ·{" "}
              {ep.rateLimit.perMinute}/min
            </Chip>
            {ep.upstream.map((u) => (
              <Chip key={u}>{u}</Chip>
            ))}
          </div>
          {ep.rateLimit.note ? (
            <p className="mt-2 font-mono text-[0.6rem] leading-relaxed text-text-muted">{ep.rateLimit.note}</p>
          ) : null}
        </div>

        <div>
          <div className={`mb-2 ${LABEL}`}>Parameters</div>
          <ParamsTable params={ep.params} />
        </div>

        <div>
          <div className={`mb-2 ${LABEL}`}>Example request</div>
          <pre className={PRE}>{ep.curl}</pre>
        </div>

        <div>
          <div className={`mb-2 ${LABEL}`}>Example response (200, illustrative)</div>
          <pre className={`${PRE} max-h-96`}>{ep.responseExample}</pre>
        </div>

        <div>
          <div className={`mb-2 ${LABEL}`}>Other responses</div>
          <ul className="space-y-1">
            {ep.errors.map((e) => (
              <li key={e.status} className="flex gap-3 text-xs leading-relaxed text-text-secondary">
                <span className="shrink-0 font-mono text-text-primary">{e.status}</span>
                <span>{e.description}</span>
              </li>
            ))}
            {ep.method === "POST" ? (
              <li className="flex gap-3 text-xs leading-relaxed text-text-secondary">
                <span className="shrink-0 font-mono text-text-primary">403</span>
                <span>
                  Browser POST from another origin (middleware; Origin names another host) — {"{ error }"}.
                </span>
              </li>
            ) : null}
            <li className="flex gap-3 text-xs leading-relaxed text-text-secondary">
              <span className="shrink-0 font-mono text-text-primary">429</span>
              <span>
                Rate limit exceeded (middleware, {ep.rateLimit.tier === "expensive" ? "expensive tier" : "general bucket"})
                — {"{ error, retryAfterSeconds }"} + Retry-After.
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export default function ApiDocsPage() {
  const groups = groupByTag(API_ENDPOINTS);
  const routeCount = new Set(API_ENDPOINTS.map((ep) => `${ep.method} ${ep.path}`)).size;
  const { deterministic: deterministicCount, claude: claudeCount } = API_COST_COUNTS;

  return (
    <main data-testid="api-docs" className="mx-auto w-full max-w-5xl px-4 py-6 md:py-10">
      {/* ---------------- Title + intro ---------------- */}
      <header className="glass-card overflow-hidden">
        <div className="flex h-9 items-center justify-between border-b border-glass px-3">
          <span className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
            Public API
          </span>
          <span className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
            OpenAPI 3.1 · v{API_VERSION}
          </span>
        </div>
        <div className="space-y-4 p-4">
          <h1 className="font-display text-2xl font-bold tracking-wide text-text-primary md:text-3xl">
            SPACEDEBRIS API
          </h1>
          <p className="max-w-3xl text-sm leading-relaxed text-text-secondary">
            Every panel on the SpaceDebris dashboard is backed by a public JSON endpoint.{" "}
            {costSummary(API_COST_COUNTS)} Each card below is marked. Every /api/* route is
            rate-limited per IP — {API_RATE_LIMIT_PER_MINUTE} requests/min in general,{" "}
            {API_EXPENSIVE_RATE_LIMIT_PER_MINUTE}/min sustained for expensive calls (every
            Claude-backed POST, GET /api/screen and /api/cola, uncached Space-Track lookups; the
            two Claude-backed GETs are served from a route cache and stay in the general tier) —
            and GET responses are CORS-enabled for any origin.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/" className={LINK}>
              ← Dashboard
            </a>
            <a href="/api/openapi" className={LINK} data-testid="api-docs-openapi-link">
              OpenAPI JSON →
            </a>
            <span className="font-mono text-[0.65rem] text-text-muted">Base URL {API_BASE_URL}</span>
          </div>
        </div>
      </header>

      {/* ---------------- Policy cards ---------------- */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="glass-card min-w-0 p-4">
          <div className={LABEL}>Rate limit</div>
          <div className="mt-1 font-display text-2xl text-text-primary">
            {API_RATE_LIMIT_PER_MINUTE}
            <span className="ml-1 font-mono text-xs text-text-secondary">req/min · IP</span>
            <span className="ml-3" style={{ color: CLAUDE_COLOR }}>
              {API_EXPENSIVE_RATE_LIMIT_PER_MINUTE}
            </span>
            <span className="ml-1 font-mono text-xs text-text-secondary">expensive</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            <RichText text={RATE_LIMIT_POLICY} />
          </p>
          <pre className={`${PRE} mt-3`}>{`curl -si "${API_BASE_URL}/api/health" \\\n  | grep -i x-ratelimit`}</pre>
        </div>
        <div className="glass-card min-w-0 p-4">
          <div className={LABEL}>CORS</div>
          <div className="mt-1 font-display text-2xl text-text-primary">
            GET
            <span className="ml-1 font-mono text-xs text-text-secondary">· OPTIONS · origin *</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">{CORS_POLICY}</p>
        </div>
        <div className="glass-card min-w-0 p-4">
          <div className={LABEL}>Cost</div>
          <div className="mt-1 font-display text-2xl text-text-primary">
            {deterministicCount}
            <span className="ml-1 font-mono text-xs text-text-secondary">
              deterministic · {claudeCount} Claude
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            Deterministic endpoints make no AI call (Space-Track and NOAA are free but
            rate-limited upstream, so responses are cached). Claude-backed endpoints run at
            temperature 0 and spend real tokens — please do not script them.
          </p>
        </div>
      </div>

      {/* ---------------- Index ---------------- */}
      <section className="glass-card mt-4 overflow-hidden">
        <div className="flex h-9 items-center justify-between border-b border-glass px-3">
          <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
            Endpoints
          </h2>
          <span className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
            {routeCount} routes · {API_ENDPOINTS.length} operations
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <tbody>
              {API_ENDPOINTS.map((ep) => (
                <tr key={ep.id} className="border-b border-glass last:border-b-0">
                  <td className="w-16 px-3 py-2">
                    <MethodBadge method={ep.method} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <a href={`#${ep.id}`} className="font-mono text-xs text-text-primary hover:text-safe">
                      {ep.path}
                    </a>
                  </td>
                  <td className="hidden px-3 py-2 text-xs text-text-secondary sm:table-cell">{ep.summary}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[0.6rem] uppercase tracking-widest">
                    {ep.cost === "claude" ? (
                      <span style={{ color: CLAUDE_COLOR }}>Claude</span>
                    ) : (
                      <span className="text-text-muted">$0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------- Endpoint cards, grouped by tag ---------------- */}
      {groups.map((group) => (
        <div key={group.tag} className="mt-8">
          <h2 className={`mb-3 ${LABEL}`}>{group.tag}</h2>
          <div className="space-y-4">
            {group.items.map((ep) => (
              <EndpointCard key={ep.id} ep={ep} />
            ))}
          </div>
        </div>
      ))}

      {/* ---------------- Assumptions footnote ---------------- */}
      <footer className="mt-8 space-y-1 border-t border-glass pt-4 font-mono text-[0.6rem] leading-relaxed text-text-muted">
        <p>
          Response examples are illustrative and abbreviated (one array element, shortened text) —
          they show shapes and field names, not live data. Space-Track fields are passed through as
          strings.
        </p>
        <p>
          Rate limit: token buckets per IP (IPv6 per /64) — general burst {API_RATE_LIMIT.capacity},
          refill {API_RATE_LIMIT.refillPerSecond}/s; expensive tier burst{" "}
          {API_EXPENSIVE_RATE_LIMIT.capacity}, {API_EXPENSIVE_RATE_LIMIT_PER_MINUTE}/min — enforced
          per Edge instance, best-effort, not a global guarantee.
        </p>
        <p>Claude costs are the project&apos;s own per-call estimates, not invoices.</p>
        <p>{API_DISCLAIMER}</p>
      </footer>
    </main>
  );
}
