// ============================================================
// Shared LMS API Client — all Workers use this to call the LMS
// ============================================================

interface FetchLmsOptions {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * Fetch from the LMS REST API.
 * Supports both X-API-Key (internal service) and Bearer token (JWT) auth.
 * If LMS_INTERNAL_KEY starts with 'eyJ' (JWT), sends as Bearer.
 * All Workers use this instead of calling fetch() directly.
 */
export async function fetchLms(
  env: { LMS_GATEWAY_URL: string; LMS_INTERNAL_KEY: string },
  options: FetchLmsOptions
): Promise<Response> {
  const url = `${env.LMS_GATEWAY_URL}${options.path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Support both Bearer token (JWT) and X-API-Key (internal service) auth
  const key = env.LMS_INTERNAL_KEY || '';
  if (key.startsWith('eyJ')) {
    headers['Authorization'] = `Bearer ${key}`;
  } else if (key) {
    headers['X-API-Key'] = key;
  }

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

/**
 * Fetch a typed resource from the LMS and unwrap the response envelope.
 *
 * LMS responses use `{ data: ... }` or bare objects. This function
 * handles both, returning the typed payload or null on failure.
 *
 * Usage:
 *   const progress = await fetchLmsResource<ProgressData>(env, path);
 *   if (!progress) { ... degraded ... }
 *
 * @returns The typed data payload, or null if the request fails or
 *          the response body is not an object.
 */
export async function fetchLmsResource<T>(
  env: { LMS_GATEWAY_URL: string; LMS_INTERNAL_KEY: string },
  path: string,
): Promise<T | null> {
  try {
    const resp = await fetchLms(env, { path });
    if (!resp.ok) return null;
    const raw = (await resp.json()) as any;
    const data: unknown = raw.data || raw;
    if (data && typeof data === 'object') return data as T;
    return null;
  } catch {
    return null;
  }
}
