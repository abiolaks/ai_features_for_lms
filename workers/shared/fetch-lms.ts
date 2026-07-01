// ============================================================
// Shared LMS API Client — all Workers use this to call the LMS
// ============================================================

interface FetchLmsOptions {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * Fetch from the LMS REST API with internal key auth.
 * All Workers use this instead of calling fetch() directly.
 */
export async function fetchLms(
  env: { LMS_GATEWAY_URL: string; LMS_INTERNAL_KEY: string },
  options: FetchLmsOptions
): Promise<Response> {
  const url = `${env.LMS_GATEWAY_URL}${options.path}`;

  const headers: Record<string, string> = {
    'X-API-Key': env.LMS_INTERNAL_KEY,
    'Content-Type': 'application/json',
  };

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    console.error(`LMS ${options.method || 'GET'} ${options.path} → ${response.status}`);
  }

  return response;
}
