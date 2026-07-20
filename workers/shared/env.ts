// ============================================================
// Shared Worker Environment Type
// ============================================================
// Every AI worker that calls LMS or AI03 extends this base.
// Workers add their own specific bindings (KV, D1, Vectorize,
// Durable Objects, etc.) on top.
// ============================================================

export interface BaseEnv {
  AI_GATEWAY: Fetcher;
  LMS_GATEWAY_URL: string;
  LMS_INTERNAL_KEY: string;
}
