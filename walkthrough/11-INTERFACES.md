# Part 11: Interfaces & Implementations

The codebase has **four layers** of interfaces, each with clear implementations.

---

## Layer 1: TypeScript Type Contracts (Compile-Time)

### Shared Types (`workers/shared/types.ts`) — 9 interfaces

**What they define:** The data shapes flowing between workers, the LMS, and storage.

| Interface | Where Defined | Implemented By |
|-----------|--------------|----------------|
| `GenerateRequest` | `shared/types.ts` | Every worker that calls the gateway |
| `GenerateResponse` | `shared/types.ts` | `ai-gateway` — the only producer |
| `LmsCourse` | `shared/types.ts` | LMS API responses (parsed by `fetchLms`) |
| `LmsLesson` | `shared/types.ts` | LMS API + indexing metadata |
| `LmsLearnerProfile` | `shared/types.ts` | LMS `/api/v1/learner/profile` |
| `LmsQuizResult` | `shared/types.ts` | LMS `/api/v1/learner/assessments` |
| `OrgBudget` | `shared/types.ts` | `ai-gateway` D1 queries |
| `IndexingJob` | `shared/types.ts` | `ai-indexing` queue messages |
| `AiSearchDocument` | `shared/types.ts` | Vectorize metadata shape |

### Shared Module Return Types

| Interface | Where Defined | Implemented By |
|-----------|--------------|----------------|
| `SpanContext` | `shared/observability.ts` | `startSpan()` returns, `setAttr()`/`endSpan()` consume |
| `GatewayResult` | `shared/gateway.ts` | `callGateway()` returns `{text, model, tokens} \| null` |
| `LearnerProfile` | `shared/lms-data.ts` | `fetchProfile()` — maps LMS response to this shape |
| `CatalogueCourse` | `shared/lms-data.ts` | `fetchCatalog()` — maps LMS response to this shape |
| `ProgressEntry` | `shared/lms-data.ts` | `fetchProgress()` — maps LMS response to this shape |
| `LmsEnv` | `shared/lms-data.ts` | Any worker needing LMS fetches (requires `LMS_GATEWAY_URL` + `LMS_INTERNAL_KEY`) |
| `BaseEnv` | `shared/env.ts` | Extended by every worker's `Env` interface |
| `FetchLmsOptions` | `shared/fetch-lms.ts` | `fetchLms()` parameter shape |

### Worker-Specific Types (local to each worker)

| Worker | Local Interfaces |
|--------|-----------------|
| **ai-tutor** | `AskRequest`, `VoiceAskRequest`, `Citation`, `MessageRow`, `TutorPersona`, `InteractionMode` |
| **ai-assistant** | `AskRequest`, `Citation`, `SuggestedCourse`, `MessageRow` |
| **ai-gateway** | `BudgetRow` |
| **ai-indexing** | `IndexRequest`, `IndexJob`, `BackfillRequest`, `ExtractPdfRequest`, `RawChunk`, `StructuredChunk` |
| **ai-paths** | `PathRequest`, `StubProfile`, `StubCourse`, `StubProgress` |

### How to trace: Interface → Implementation

```
interface GenerateRequest           shared/types.ts:6
     │
     ├── Producer: every worker constructing a gateway call
     │     e.g., callGateway(env.AI_GATEWAY, prompt, orgId, tier)
     │     internally builds { messages, tier, org_id }
     │
     └── Consumer: ai-gateway/src/index.ts
           let body: GenerateRequest;
           body = await req.json();
           // validates body.messages, body.tier, body.org_id
```

---

## Layer 2: Environment Contracts (Runtime Bindings)

Every worker declares an `Env` interface. This is the **runtime contract** between the worker code and Cloudflare's platform. The actual values come from `wrangler.jsonc` bindings + secrets.

```
BaseEnv (shared/env.ts)
  ├── AI_GATEWAY: Fetcher
  ├── LMS_GATEWAY_URL: string
  └── LMS_INTERNAL_KEY: string

Extended by each worker:

ai-gateway Env:
  ├── BaseEnv doesn't apply (gateway IS the AI_GATEWAY)
  ├── AI: Ai                          ← Workers AI binding
  ├── DB: D1Database                   ← D1 (org_budgets table)
  └── LMS_CACHE: KVNamespace

ai-tutor Env:
  ├── (BaseEnv not used — manual)
  ├── AI: any                         ← Workers AI (embeddings)
  ├── VECTORIZE_INDEX: VectorizeIndex  ← lms-lessons
  ├── AI_GATEWAY: Fetcher             ← service binding → ai-gateway
  └── TUTOR_SESSION: DurableObjectNamespace<TutorSession>

ai-assistant Env:
  ├── AI: any
  ├── VECTORIZE_INDEX: VectorizeIndex
  ├── AI_GATEWAY: Fetcher
  ├── ASSISTANT_SESSION: DurableObjectNamespace<AssistantSession>
  ├── LMS_GATEWAY_URL: string
  └── LMS_INTERNAL_KEY: string

ai-indexing Env:
  ├── AI: any
  ├── STREAM: any                     ← Cloudflare Stream binding
  ├── VECTORIZE_INDEX: VectorizeIndex
  ├── INDEXING_QUEUE: any             ← Queue binding
  ├── CLOUDFLARE_STREAM_API_TOKEN: string
  ├── CLOUDFLARE_ACCOUNT_ID: string
  ├── LMS_WEBHOOK_SECRET: string
  ├── LMS_GATEWAY_URL: string
  ├── LMS_INTERNAL_KEY: string
  └── LMS_CONTENT: R2Bucket

ai-paths Env:
  └── extends BaseEnv {}              ← cleanest pattern

ai-recommendations Env:
  └── extends BaseEnv { LMS_CACHE, AI?, VECTORIZE_INDEX?, ...weights }
```

**Implementation:** `wrangler.jsonc`
```jsonc
{
  "ai": { "binding": "AI" },
  "vectorize": [{ "binding": "VECTORIZE_INDEX", "indexName": "lms-lessons" }],
  "services": [{ "binding": "AI_GATEWAY", "service": "ai-gateway" }],
  "durable_objects": [{ "name": "TutorSession", "class_name": "TutorSession" }],
  "d1_databases": [{ "binding": "DB", "database_name": "lms-platform" }],
  "kv_namespaces": [{ "binding": "LMS_CACHE", "id": "..." }],
  "r2_buckets": [{ "binding": "LMS_CONTENT", "bucket_name": "lms-content-staging" }],
  "queues": { "consumers": [{ "queue": "indexing-jobs" }] }
}
```

---

## Layer 3: Service Contracts (RPC / HTTP)

### Gateway Contract

```
Interface (caller side)              Implementation (ai-gateway)
─────────────────────────────────    ─────────────────────────────
POST /generate                       env.AI.run(model, {messages, max_tokens})
  { messages, tier, org_id }    →    → { response, model_used, tokens_used, throttle }
  Returns GatewayResult | null

POST /stream                         env.AI.run(model, {messages, stream:true})
  { messages, tier, org_id }    →    → SSE: data: {"type":"token","text":"..."}
                                       SSE: data: {"type":"done","response":"...","tokens_used":N}

GET /health?org_id=                   getBudget(DB, orgId)
  Returns { models[], budget }
```

### DO Contract (ai-tutor)

```
Interface (caller side)                     Implementation (TutorSession)
──────────────────────────────────────      ───────────────────────────
fetch handler:                              async ask(body: AskRequest): Response
  session = TUTOR_SESSION.get(              async clearHistory(origin): Response
    idFromName(`session-${id}-${cid}`))
  return session.ask(body)                  async fetch(req): Response  (WS upgrade)

Request shape:                              Request shape:
  AskRequest { question, lesson_id,           AskRequest { question, lesson_id,
    course_id, org_id, expand_scope?,           course_id, org_id, expand_scope?,
    module_id?, origin? }                       module_id?, origin? }

Response shape:                             Response shape:
  { answer, citations[],                     { answer, citations[],
    scope_expansion_suggested,                 scope_expansion_suggested,
    history_length }                           history_length }
```

### DO Contract (ai-assistant)

```
Interface (caller side)                     Implementation (AssistantSession)
──────────────────────────────────────      ───────────────────────────────
fetch handler:                              async ask(body: AskRequest): Response
  session = ASSISTANT_SESSION.get(          async clearHistory(origin): Response
    idFromName(`assistant-${learner_id}`))
  return session.ask(body)

Request shape:                              Request shape:
  AskRequest { question, learner_id,          AskRequest { question, learner_id,
    org_id, origin? }                           org_id, origin? }

Response shape:                             Response shape:
  { answer, citations[],                     { answer, citations[],
    suggested_courses[],                       suggested_courses[],
    history_length }                           history_length }
```

### LMS Contract

```
Interface (shared/fetch-lms.ts)                 Implementation (LMS Python/Azure)
────────────────────────────────────            ─────────────────────────────
fetchLms(env, { path, method?, body? })         REST API at LMS_GATEWAY_URL
fetchLmsResource<T>(env, path)                  Auth: X-API-Key or Bearer JWT

Endpoints consumed:
  GET  /api/v1/health
  GET  /api/v1/learner/profile?user_id=
  GET  /api/v1/catalog?organization_id=
  GET  /api/v1/progress/user?userId=
  GET  /api/v1/lessons/{id}
  GET  /api/v1/learner/assessments/{id}
  GET  /api/v1/learner/assessments/attempts/{id}
  GET  /api/v1/modules/{moduleId}/lessons
  GET  /api/v1/learner/assessments/summary
  GET  /api/v1/admin/progress/aggregate?organization_id=&period=
  GET  /api/v1/admin/assessments/aggregate?organization_id=&period=
  GET  /api/v1/admin/engagement?organization_id=&period=

  Contract spec: lmsapi.json (OpenAPI, 4.2MB)
```

---

## Layer 4: Module Interfaces (Public API of Shared Modules)

Each file in `shared/` is a module with a well-defined **public interface** (exported functions) and a private **implementation** (internal logic).

### `observability.ts`

```typescript
// INTERFACE (3 exported functions)
export function startSpan(name: string): SpanContext
export function setAttr(ctx: SpanContext, key: string, value: unknown): void
export function endSpan(ctx: SpanContext): void

// IMPLEMENTATION
//  - SpanContext is { name, attrs: {}, startMs: Date.now() }
//  - endSpan computes duration, merges attrs, console.log(JSON.stringify(...))
```

### `cors.ts`

```typescript
// INTERFACE (3 exported functions)
export function corsHeadersFor(origin?: string | null): Record<string, string>
export function json(data: unknown, status = 200, origin?: string | null): Response
export function handleCors(req: Request): Response | null

// IMPLEMENTATION
//  - Checks origin against ALLOWED_ORIGINS whitelist
//  - Echoes back matched origin (required for credentialed requests)
//  - Fallback to first entry in whitelist
```

### `gateway.ts`

```typescript
// INTERFACE (1 exported function + 1 type)
export interface GatewayResult { text: string; model: string; tokens: number }
export async function callGateway(gateway, prompt, orgId, tier?): Promise<GatewayResult | null>

// IMPLEMENTATION
//  - Constructs Request to https://ai-gateway/generate
//  - Parses JSON response, extracts response/model/tokens
//  - Returns null on any failure (fetch error, non-ok, parse error)
```

### `fetch-lms.ts`

```typescript
// INTERFACE (2 exported functions)
export async function fetchLms(env, options): Promise<Response>
export async function fetchLmsResource<T>(env, path): Promise<T | null>

// IMPLEMENTATION
//  - Auto-detects auth: JWT (starts with 'eyJ') → Bearer, else → X-API-Key
//  - Logs non-ok responses
//  - fetchLmsResource unwraps { data } envelope or bare object
```

### `lms-data.ts`

```typescript
// INTERFACE (3 exported functions + 4 types)
export interface LearnerProfile { skills, goals, experience_level, interests, streak_days, points }
export interface CatalogueCourse { id?, title, difficulty, category, prerequisites }
export interface ProgressEntry { title, status, progress_pct }
export interface LmsEnv { LMS_GATEWAY_URL, LMS_INTERNAL_KEY }

export async function fetchProfile(env, stub?, learnerId?): Promise<{profile, fromLms}>
export async function fetchCatalog(env, orgId, stub?): Promise<{catalogue, fromLms}>
export async function fetchProgress(env, learnerId, stub?): Promise<{progress, fromLms}>

// IMPLEMENTATION
//  - Each fetcher: try LMS → map fields → if empty/fail → return stub
//  - Catalog has secondary fallback: /api/v1/public/courses
//  - All return { data, fromLms: boolean } for degraded mode awareness
```

### `test-utils.ts`

```typescript
// INTERFACE (3 exported functions)
export function createMockGateway(response, ok?): { fetch: ReturnType<typeof vi.fn> }
export function createLlmResponse(payload): object
export function spyOnSpans(): { logs: string[], spans: (name: string) => Record<string, unknown>[] }

// IMPLEMENTATION
//  - createMockGateway: vi.fn → resolves to new Response(JSON.stringify(response))
//  - createLlmResponse: wraps payload in { response: JSON.stringify(payload), model_used, tokens_used, ... }
//  - spyOnSpans: vi.spyOn(console, 'log'), returns filter function for structured JSON
```

### `llm-parser.ts`

```typescript
// INTERFACE (1 exported function)
export function parseLlmJson<T>(response: string): T | null

// IMPLEMENTATION
//  - Tries ```json block extraction
//  - Tries bare { } extraction
//  - Handles truncated JSON (balanceBraces)
//  - Handles arrays vs objects (picks longer match)
//  - Returns null if nothing parsable
```

### `sanitize.ts`

```typescript
// INTERFACE (1 exported function)
export function sanitize(text: string | undefined, maxLength = 500): string

// IMPLEMENTATION
//  - Null/undefined → ""
//  - Strips surrounding quotes
//  - Trims whitespace
//  - Caps at maxLength
```

---

## Summary: The Dependency Graph

```
ai-tutor/src/index.ts
  ├── imports Env interface (local)
  ├── imports from shared/cors.ts      (json, handleCors)
  ├── imports from shared/observability (startSpan, setAttr, endSpan)
  └── delegates to TutorSession DO
        ├── imports from shared/cors.ts      (json)
        ├── imports from shared/observability (startSpan, setAttr, endSpan)
        ├── calls env.AI.run(EMBEDDING_MODEL)        → Workers AI
        ├── calls env.VECTORIZE_INDEX.query(vector)   → Vectorize
        └── calls env.AI_GATEWAY.fetch(...)           → ai-gateway worker
              ├── calls env.AI.run(model, {...})      → Workers AI LLM
              └── calls env.DB (D1)                   → budget tracking

Every data type crossing these boundaries is defined in shared/types.ts.
Every module boundary is an exported function in shared/.
Every runtime binding is declared in the worker's Env interface + wrangler.jsonc.
```
