import { NextResponse } from "next/server";
import { OPENAPI_SPEC } from "@/lib/apiSpec";

/* ============================================================
   GET /api/openapi

   Session 6 — Feature 5. Serves the OpenAPI 3.1 document for every
   /api/* route. The document is a static, typed const built in
   lib/apiSpec.ts from the SAME endpoint list that renders /docs, so
   the machine-readable spec and the human docs cannot drift.

   - No upstream calls, no Claude, no credentials: pure JSON.
   - Cache-Control: public, max-age=300 — the document only changes
     on deploy, so clients may reuse it for 5 minutes.
   - Rate limit + CORS headers are added by middleware.ts like every
     other /api/* route (GET ⇒ Access-Control-Allow-Origin: *).
   - Default runtime (no Node-only API needed); never throws — the
     spec is built at module load and serialised here.
   - force-dynamic: an argument-less GET handler would otherwise be
     prerendered at build time, and the static-route cache layer may
     replace our Cache-Control with its own. Serialising the const
     per request is negligible, and clients still reuse the
     response for 300 s because of the header above.
   ============================================================ */

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  try {
    return NextResponse.json(OPENAPI_SPEC, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/openapi] error:", detail);
    return NextResponse.json(
      { error: "Failed to serialise the OpenAPI document.", detail },
      { status: 500 }
    );
  }
}
