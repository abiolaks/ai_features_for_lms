# Part 2: Shared Module Deep-Dive

Every worker imports from `workers/shared/`. These 9 files are the backbone. No duplication allowed — if it's in shared, import it.

## 1. `types.ts` — Shared TypeScript Types

The contract between all workers. Key types:

```typescript
// What every worker sends to the gateway
interface GenerateRequest {
  messages: { role: string; content: string }[];
  tier: 'standard' | 'quality';
  org_id: string;
}

// What the gateway returns
interface GenerateResponse {
  response: string;
  model_used: string;
  provider: 'cloudflare';
  tokens_used: number;
  throttle_warning: boolean;
}

// LMS data shapes
interface LmsCourse { id, title, description, contentType, cloudflareVideoId, ... }
interface LmsLesson { id, title, content, contentType, courseId, order, duration }
interface LmsLearnerProfile { id, org_id, skill_levels, completed_courses, interests }
interface LmsQuizResult { id, quiz_id, learner_id, score, answers, completed_at }

// Budget tracking (D1)
interface OrgBudget { org_id, monthly_token_cap, tokens_used_this_period, billing_period_start }

// Queue jobs
interface IndexingJob { type, id, org_id, cloudflareVideoId, action }
```

## 2. `cors.ts` — CORS Headers & JSON Response Helper

**Why it exists:** The LMS frontend (`learning.lumerax.co`) calls workers from a different origin. Without CORS headers + OPTIONS preflight handling, the browser blocks every cross-origin request.

**Critical bug reference (2026-07-10):** DO methods in TutorSession.ts used a **local** `json()` function that lacked CORS headers. Browser blocked all responses from `/tutor/ask` with "No 'Access-Control-Allow-Origin' header". Fix: imported shared `json()` with `origin` parameter.

```typescript
// Allowed origins (echoed back for credentialed requests)
const ALLOWED_ORIGINS = [
  "https://learning.lumerax.co",
  "https://lms-staging.azurewebsites.net",
  "null",  // local file:// development
  "http://localhost:3000",
  "http://localhost:8000",
  "http://localhost:5173",
];

// Build CORS headers for a specific origin
corsHeadersFor(origin?: string | null): Record<string, string>

// Return JSON with CORS headers. Accepts optional origin for DO methods.
json(data, status = 200, origin?: string | null): Response

// Handle OPTIONS preflight. Returns null if not OPTIONS.
handleCors(req: Request): Response | null
```

**Usage pattern in every fetch handler:**
```typescript
export default {
  async fetch(req, env) {
    const preflight = handleCors(req);
    if (preflight) return preflight;
    // ... rest of handler
    return json({ answer: "hi" }, 200, req.headers.get("Origin"));
  }
}
```

**DO methods MUST pass origin:**
```typescript
// In fetch handler:
const session = env.TUTOR_SESSION.get(idFromName(...));
return session.ask({ ...body, origin: req.headers.get("Origin") });

// In DO:
async ask(body) {
  return json({ answer }, 200, body.origin);
}
```

## 3. `fetch-lms.ts` — LMS REST Client

Every worker that needs LMS data uses this. Two functions:

```typescript
// Low-level: raw fetch with auth headers
fetchLms(env, { path, method?, body? }): Promise<Response>

// High-level: typed fetch with response unwrapping
fetchLmsResource<T>(env, path): Promise<T | null>
```

**Auth mechanism:** Supports both `X-API-Key` (internal service) and `Bearer <JWT>`. Auto-detects based on whether `LMS_INTERNAL_KEY` starts with `eyJ` (JWT header).

**Usage:**
```typescript
const progress = await fetchLmsResource<ProgressData>(env, `/api/v1/progress/user?userId=${id}`);
if (!progress) { /* degraded */ }
```

## 4. `gateway.ts` — AI Gateway Client

Wraps the service binding call to ai-gateway. Handles fetch → parse → normalize.

```typescript
callGateway(gateway: Fetcher, prompt: string, orgId: string, tier?: string): Promise<GatewayResult | null>
```

Returns `{ text, model, tokens }` or `null` if unreachable.

**What it does internally:**
1. Calls `gateway.fetch("https://ai-gateway/generate", { method: "POST", body: { messages, tier, org_id } })`
2. Parses JSON response
3. Extracts `response` (text), `model_used` and `tokens_used`
4. Returns null on any failure

## 5. `lms-data.ts` — Structured LMS Data Fetchers

Three fetchers with **stub fallback** pattern. Each returns `{ data, fromLms: boolean }`:

```typescript
fetchProfile(env, stub?, learnerId?): Promise<{ profile: LearnerProfile, fromLms: boolean }>
fetchCatalog(env, orgId, stub?): Promise<{ catalogue: CatalogueCourse[], fromLms: boolean }>
fetchProgress(env, learnerId, stub?): Promise<{ progress: ProgressEntry[], fromLms: boolean }>
```

**Stub fallback means:** If LMS is unreachable, return a minimal default (empty profile, stub catalog, empty progress) instead of failing. The `fromLms: false` flag lets the caller know data came from stub.

**Catalog has a secondary fallback:** If authenticated catalog is empty, tries the public `/api/v1/public/courses` endpoint.

## 6. `observability.ts` — Structured Span Helpers

Generates structured JSON via `console.log` for `wrangler tail` / Workers Logs:

```typescript
startSpan(name: string): SpanContext
setAttr(ctx: SpanContext, key: string, value: unknown): void
endSpan(ctx: SpanContext): void  // emits JSON to console.log
```

**Output format:**
```json
{"span":"tutor.ask","duration_ms":150,"org_id":"org-test","citations":5,"history_size":4}
```

**Naming convention:** dot notation — `worker.component`. Examples: `tutor.ask`, `assistant.request`, `tutor.gateway`, `voice.stt`.

**Every handler wraps in a `.request` span:**
```typescript
const reqSpan = startSpan("assistant.request");
setAttr(reqSpan, "method", req.method);
setAttr(reqSpan, "path", path);
// ... handle ...
setAttr(reqSpan, "status", response.status);
endSpan(reqSpan);
```

**Every DO method wraps in its own span:**
```typescript
const askSpan = startSpan("assistant.ask");
setAttr(askSpan, "org_id", body.org_id);
try { /* ... */ } catch (e) {
  setAttr(askSpan, "error", e.message);
  endSpan(askSpan);
}
```

## 7. `test-utils.ts` — Mock Factories & Span Tracking

Three shared test helpers (used by all 13 worker test suites):

```typescript
// Mock the gateway service binding
createMockGateway(response: object | null, ok = true): { fetch: ReturnType<typeof vi.fn> }

// Create a realistic gateway response body
createLlmResponse(payload: unknown): object  // { response: JSON.stringify(payload), model_used, tokens_used, ... }

// Spy on console.log to capture structured span JSON for assertions
spyOnSpans(): { logs: string[], spans: (name: string) => Record<string, unknown>[] }
```

**Test pattern:**
```typescript
const { spans } = spyOnSpans();
// ... run test ...
const blocked = spans('assistant.injection_blocked');
expect(blocked).toHaveLength(1);
expect(blocked[0].pattern).toBe('ignore_instructions');
```

## 8. `llm-parser.ts` — LLM JSON Response Parser

LLMs often wrap JSON in markdown code blocks or truncate mid-generation. This handles both:

```typescript
parseLlmJson<T>(response: string): T | null
```

**What it handles:**
1. Markdown code blocks: `` ```json\n{...}\n``` ``
2. Bare JSON objects: `{...}`
3. Leading/trailing text around the JSON
4. Truncated JSON — balances braces and adds missing closes
5. Array responses (returns the longer of `[...]` vs `{...}`)

## 9. `sanitize.ts` — String Sanitizer

Cleans LLM-generated string fields before including in API responses:

```typescript
sanitize(text: string | undefined, maxLength = 500): string
```

Strips leading/trailing quotes, trims whitespace, caps at maxLength. Returns empty string for null/undefined.

## 10. `env.ts` — Base Environment Type

```typescript
export interface BaseEnv {
  AI_GATEWAY: Fetcher;
  LMS_GATEWAY_URL: string;
  LMS_INTERNAL_KEY: string;
}
```

Workers extend this with their specific bindings (Vectorize, D1, KV, DO namespace, etc.).
