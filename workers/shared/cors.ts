// ============================================================
// Shared CORS helpers — every frontend-facing Worker uses these
// ============================================================
// The LMS frontend calls Workers from a different origin. Without
// CORS headers + OPTIONS preflight handling, the browser blocks
// every cross-origin request. Every Worker that serves the LMS
// frontend must use these helpers.
//
// IMPORTANT: Durable Object RPC methods (e.g. session.ask())
// return Response objects directly to the browser — they bypass
// the main worker's fetch handler. DO methods MUST use this
// module's json() helper (not a local copy) to ensure CORS
// headers are present on every response.
//
// BUG REFERENCE (2026-07-10): ai-tutor CORS failures.
// DO methods in TutorSession.ts used a local json() function
// that lacked CORS headers. Browser blocked all cross-origin
// responses from /tutor/ask and /tutor/clear with:
//   "No 'Access-Control-Allow-Origin' header is present"
// Fix: imported shared json() from this module, passed origin
// from the fetch handler into DO RPC calls.
// ============================================================

const ALLOWED_ORIGINS = [
  "https://learning.lumerax.co",
  "https://lms-staging.azurewebsites.net",
  "null",  // local file:// development
  "http://localhost:3000",
  "http://localhost:8000",
  "http://localhost:5173",
];

/** Wildcard patterns — any origin matching these suffix/prefix patterns is allowed. */
const ALLOWED_ORIGIN_PATTERNS = [
  "https://*.ai-dashboard-edd.pages.dev",   // dashboard preview deploys
  "https://ai-dashboard-edd.pages.dev",      // dashboard production
];

/** Check whether an origin matches an allowlist entry (exact or wildcard). */
function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => {
    // Convert wildcard pattern to regex: escape dots, replace * with [^.]+
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]+") + "$"
    );
    return regex.test(origin);
  });
}

/**
 * Build CORS headers for a given origin.
 * If the origin is in the allowlist, echo it back (required for
 * credentialed requests). If not, fall back to the first entry.
 * Call without an argument for wildcard-compatible responses.
 */
export function corsHeadersFor(origin?: string | null): Record<string, string> {
  const allowed =
    origin && isAllowedOrigin(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Return a JSON response with CORS headers.
 * Accepts an optional origin string so DO methods (which don't
 * have access to the original Request) can still emit correct
 * per-origin CORS headers.
 *
 *   json({ answer: "hi" })              // default origin
 *   json({ answer: "hi" }, 200, origin)  // specific origin
 */
export function json(data: unknown, status = 200, origin?: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeadersFor(origin),
    },
  });
}

/**
 * Handle CORS preflight (OPTIONS) requests.
 * Call this at the top of your fetch handler:
 *
 *   const preflight = handleCors(req);
 *   if (preflight) return preflight;
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeadersFor(req.headers.get("Origin")),
    });
  }
  return null;
}
