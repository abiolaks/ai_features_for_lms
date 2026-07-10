// ============================================================
// Shared CORS helpers — every frontend-facing Worker uses these
// ============================================================
// The LMS frontend calls Workers from a different origin. Without
// CORS headers + OPTIONS preflight handling, the browser blocks
// every cross-origin request. Every Worker that serves the LMS
// frontend must use these helpers.
// ============================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

/**
 * Return a JSON response with CORS headers.
 * Use this instead of building `new Response()` manually.
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
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
      headers: CORS_HEADERS,
    });
  }
  return null;
}
