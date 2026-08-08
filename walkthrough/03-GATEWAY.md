# Part 3: The Gateway — ai-gateway Worker

The gateway is the **only** worker that calls `env.AI.run()`. All 12 frontend workers route through it. Internal-only (no public URL, service binding only).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health?org_id=` | Model connectivity + budget status |
| `GET` | `/budget?org_id=` | Budget details for dashboard |
| `POST` | `/generate` | Non-streaming LLM call |
| `POST` | `/stream` | SSE streaming LLM call |

## Request/Response Flow for `/generate`

```
Worker sends:
  POST https://ai-gateway/generate
  { messages: [{ role: "user", content: "..." }], tier: "standard"|"quality", org_id: "org-123" }

Gateway:
  1. Validate: messages, tier (standard/quality), org_id
  2. Budget check:
     - ensureBudget(): INSERT OR IGNORE into D1 org_budgets (default cap: 100K tokens)
     - getBudget(): SELECT from D1
     - If remaining <= 0 → 429 "budget_exhausted"
  3. Select model:
     - standard → "@cf/meta/llama-3.2-3b-instruct" (max_tokens: 1024)
     - quality  → "@cf/mistral/mistral-7b-instruct-v0.2-lora" (max_tokens: 2048)
  4. Call env.AI.run(model, { messages, max_tokens })
  5. Track tokens: UPDATE org_budgets SET tokens_used += N
  6. Return { response, model_used, provider, tokens_used, throttle_warning }

Worker receives:
  { response: "...", model_used: "@cf/meta/llama-3.2-3b-instruct",
    provider: "cloudflare", tokens_used: 150, throttle_warning: false }
```

## Streaming Endpoint (`/stream`)

Same as `/generate` but with `stream: true`. Returns SSE (Server-Sent Events):

```
data: {"type":"token","text":"Hello"}
data: {"type":"token","text":" world"}
data: {"type":"done","response":"Hello world","tokens_used":2}
```

**Implementation detail:** The Workers AI streaming response is a `ReadableStream<Uint8Array>`. We `.tee()` it into two branches:
1. A side-reader that accumulates the full response (for the final "done" event + token counting)
2. A transformer that converts Workers AI SSE chunks into our format with `{ type: "token", text: "..." }`

Token tracking happens after the stream completes (in the `flush` callback of the TransformStream).

## Budget Tracking (D1)

Table: `org_budgets`

```sql
CREATE TABLE org_budgets (
  org_id TEXT PRIMARY KEY,
  monthly_token_cap INTEGER NOT NULL DEFAULT 100000,
  tokens_used_this_period INTEGER NOT NULL DEFAULT 0,
  billing_period_start INTEGER NOT NULL
);
```

- Default cap: 100,000 tokens/month
- `ensureBudget()`: INSERT OR IGNORE (idempotent — only creates if not exists)
- `trackTokens()`: atomic increment
- Budget exhaustion → 429, caller sees `throttle_warning: true`

## Model Map

Currently hardcoded:
```typescript
const MODELS = {
  standard: '@cf/meta/llama-3.2-3b-instruct',
  quality: '@cf/mistral/mistral-7b-instruct-v0.2-lora',
};
```

The `quality` model here differs from what's in the architecture doc (`llama-3.3-70b-instruct-fp8-fast`) — this is the currently deployed model. Models can be changed here and propagate to all workers instantly.

## Error Handling

| Scenario | Status | Response |
|----------|--------|----------|
| Invalid JSON | 400 | `{ error: "invalid_json" }` |
| Missing messages | 400 | `{ error: "missing_field", field: "messages" }` |
| Invalid tier | 400 | `{ error: "invalid_tier", valid: ["standard", "quality"] }` |
| Missing org_id | 400 | `{ error: "missing_field", field: "org_id" }` |
| Budget exhausted | 429 | `{ error: "budget_exhausted", message: "..." }` |
| Workers AI error | 502 | `{ error: "ai_call_failed", detail: "..." }` |
