# AI03 LLM Gateway — Code Walkthrough

> How the gateway works, why each decision was made, and how to explain it to someone else.

---

## What Problem Does This Solve?

Without the gateway, every AI Worker (tutor, recommendations, insights) would:

1. Call Workers AI directly — scattered model selection logic
2. Track tokens separately — no unified budget enforcement
3. Need its own error handling for AI failures

The gateway solves all three by being the **single choke point**:

```
Instead of:
  AI04 Tutor ──→ Workers AI (llama)
  AI06 Paths ──→ Workers AI (llama)
  AI07 Recs  ──→ Workers AI (mistral)
  AI08 Quiz  ──→ Workers AI (llama)

We have:
  AI04 Tutor ──┐
  AI06 Paths ──┤
  AI07 Recs  ──┼──→ AI03 Gateway ──→ Workers AI (picks model)
  AI08 Quiz  ──┘
                  └──→ D1 (tracks all tokens)
```

**Change a model?** One line in `MODELS`. **Add budget alerts?** One place. **See all token usage?** One SQL query.

---

## File-by-File Breakdown

### 1. `workers/shared/types.ts` — The Contract

```typescript
export interface GenerateRequest {
  messages: { role: string; content: string }[];
  tier: 'standard' | 'quality';
  org_id: string;
}
```

This is the **only** way any Worker talks to the gateway. Every caller must send:
- `messages` — OpenAI-compatible chat format (system/user/assistant roles)
- `tier` — picks cheap vs. powerful model
- `org_id` — whose budget is charged

```typescript
export interface GenerateResponse {
  response: string;
  model_used: string;
  provider: 'cloudflare';
  tokens_used: number;
  throttle_warning: boolean;
}
```

Every caller gets back:
- `response` — the AI's text
- `model_used` — which model ran (traceability)
- `tokens_used` — how much this cost
- `throttle_warning` — "you're about to hit your cap"

**Why share these types?** Because AI04, AI06, AI07, AI08 all import from `../../shared/types.ts`. If we change the contract, TypeScript catches it everywhere at compile time — no runtime surprises.

---

### 2. `workers/ai-gateway/wrangler.jsonc` — What Cloudflare Gives This Worker

```jsonc
{
  "ai": { "binding": "AI" },              // → env.AI.run(model, input)
  "d1_databases": [{ "binding": "DB" }],   // → env.DB.prepare("SELECT...")
  "kv_namespaces": [{ "binding": "LMS_CACHE" }] // → env.LMS_CACHE.get("key")
}
```

These are **bindings** — Cloudflare injects them at runtime. The Worker doesn't import a database client or AI SDK. It just uses `env.AI`, `env.DB`, `env.LMS_CACHE` as if they were globals.

| Binding | What it does | Used for |
|---------|-------------|----------|
| `AI` | Calls Workers AI models | Text generation (llama-3.2, mistral-7b) |
| `DB` | SQL queries on D1 | Read/write `org_budgets` table |
| `LMS_CACHE` | Key-value store (KV) | Future: caching common responses |

**Currently KV is provisioned but unused.** It's wired in now so we don't forget later when we add response caching.

---

### 3. `workers/ai-gateway/src/index.ts` — The Worker (90 lines)

#### Request Flow

Every `POST /generate` goes through 6 stages. Here's the full trace for a real call:

```
INPUT:
  POST /generate
  Body: { "messages": [{"role":"user","content":"Hello"}],
          "tier": "standard",
          "org_id": "org-test" }

OUTPUT:
  { "response": "Hello from me.",
    "model_used": "@cf/meta/llama-3.2-3b-instruct",
    "provider": "cloudflare",
    "tokens_used": 48,
    "throttle_warning": false }
```

#### Stage 1: Guard Clauses (Lines 28–48)

```typescript
if (req.method !== 'POST')  → 405
if (path !== '/generate')   → 404
if (invalid JSON)           → 400
if (!body.messages)         → 400 "missing_field: messages"
if (tier not valid)         → 400 "invalid_tier"
if (!body.org_id)           → 400 "missing_field: org_id"
```

**Why before the DB call?** These are free checks. No network, no SQL, no AI. We reject invalid requests immediately. This saves D1 queries and prevents bad data from reaching Workers AI.

**The order matters.** We check `POST` first (HTTP-level), then path (routing), then body (parse), then fields (validation). Each builds on the last.

---

#### Stage 2: Budget Check (Lines 51–64)

```typescript
const budget = await getBudget(env.DB, body.org_id);
const exhausted = budget && budget.tokens_used_this_period >= budget.monthly_token_cap;
```

This calls `getBudget()` which runs:
```sql
SELECT * FROM org_budgets WHERE org_id = 'org-test'
```

Returns a row like:
```
{ org_id: "org-test", monthly_token_cap: 100000, tokens_used_this_period: 48, ... }
```

**If `budget` is `null`** (org not in table): we let the call through. No budget = unlimited. This is intentional — you can add an org to the table later when you want to start tracking. Throttle defaults to `false`.

**If budget is exhausted** (tokens_used >= cap): returns `429` immediately:
```json
{ "error": "budget_exhausted",
  "message": "Contact your org admin to increase the budget." }
```

**Critical design choice:** The budget check happens **before** calling Workers AI. If an org is out of tokens, we never reach the model — zero cost, zero latency for the AI call.

---

#### Stage 3: Call Workers AI (Lines 67–81)

```typescript
const model = MODELS[body.tier];
// standard → "@cf/meta/llama-3.2-3b-instruct"
// quality  → "@cf/mistral/mistral-7b-instruct-v0.2-lora"

const maxTokens = body.tier === 'quality' ? 2048 : 1024;
```

**Why `MODELS` is a const map, not inline strings:** If Cloudflare deprecates llama-3.2 and we switch to llama-4, it's one line change. If we add a 3rd tier later, it's one object entry.

**Why different max_tokens per tier:**
- Standard (1024): shorter responses, cheaper, faster — good for tutor Q&A
- Quality (2048): longer reasoning, better for question generation, learning paths

```typescript
aiResult = await env.AI.run(model, { messages: body.messages, max_tokens: maxTokens });
```

`env.AI.run()` is Workers AI's native API. We pass the model string and the chat messages. It returns:
```typescript
{ response: "Hello from me.",
  usage: { total_tokens: 48, prompt_tokens: 10, completion_tokens: 38 } }
```

**Error handling:** Wrapped in try/catch. If Workers AI is down or the model is unavailable, we return `502` with the error detail. The caller sees a clean error instead of a Worker crash.

---

#### Stage 4: Token Tracking (Lines 83–91)

```typescript
const tokensUsed = aiResult.usage?.total_tokens ?? 0;
const throttle = budget
  ? budget.tokens_used_this_period + tokensUsed >= budget.monthly_token_cap
  : false;

await trackTokens(env.DB, body.org_id, tokensUsed);
```

**`throttle` calculation:**
- Uses the **pre-call** budget (loaded in Stage 2) + the tokens just consumed
- If that sum crosses the cap, `throttle_warning = true`
- This means the warning fires on the call that **crosses** the threshold — the caller knows "this response may be your last"

**`trackTokens()`:**
```sql
UPDATE org_budgets
SET tokens_used_this_period = tokens_used_this_period + 48
WHERE org_id = 'org-test'
```

Simple increment. Future enhancement: a separate cron Worker resets `tokens_used_this_period` at month boundaries.

---

#### Stage 5: Return Response (Lines 93–104)

```typescript
const response: GenerateResponse = {
  response: aiResult.response,
  model_used: model,
  provider: 'cloudflare',
  tokens_used: tokensUsed,
  throttle_warning: throttle,
};
return json(response, 200);
```

**Why include `model_used` in the response?** Debugging. If AI04 Tutor calls the gateway and gets a weird answer, it can log which model produced it. In production tracing (Phoenix/OTel), this field gets attached to the span.

**Why always `"provider": "cloudflare"`?** Future-proofing. If we later add a fallback to another provider (e.g., Anthropic via a different binding), the provider field tells callers where the response came from.

---

### Helper Functions

#### `getBudget(db, orgId)` → `BudgetRow | null`

One SQL query. Returns `null` if the org isn't in the table (no budget = unlimited).

#### `trackTokens(db, orgId, tokens)` → `void`

Atomic SQL increment. Uses `SET tokens_used_this_period = tokens_used_this_period + ?` which is safe for concurrent calls (SQLite handles the increment atomically).

#### `json(data, status)` → `Response`

```typescript
function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

Tiny helper. Avoids writing `new Response(JSON.stringify(...))` 10+ times.

---

## Why This Design Works

### 1. Single Responsibility

The gateway does exactly one thing: **mediate LLM calls**. It doesn't know about courses, lessons, quizzes, or learners. That's the feature Workers' job. This means:
- Gateway can be tested in isolation (14 tests, no LMS needed)
- Gateway can be scaled independently
- Gateway can be swapped or extended without touching features

### 2. Defensive by Default

Every failure mode is handled:
- Invalid input → 400 before any expensive operation
- Budget exhausted → 429 before the AI call
- AI call fails → 502 with error details
- Org not in DB → allowed through (no hard dependency on budget table)

### 3. Observable

Every response includes `model_used`, `tokens_used`, `provider`. The `wrangler.jsonc` has observability enabled (`head_sampling_rate: 1`). In the Cloudflare dashboard, every AI call shows latency, token count, model, and status.

### 4. Testable

The test file (`test/index.test.ts`) proves the Worker works without calling the real Workers AI. We mock `env.AI.run()` because:
- Workers AI only runs on Cloudflare's edge (not in local `workerd`)
- Unit tests should test **our logic**, not Cloudflare's inference

The test wrangler config (`wrangler.test.jsonc`) omits the `ai` binding to avoid the runtime crash, and the test file injects `env.AI = { run: mockFn }` in `beforeAll()`.

---

## How to Explain This to Someone

> "AI03 is our LLM gateway. It's the single entry point for all AI calls in the system. Every feature Worker — tutor, learning paths, recommendations — sends its LLM requests here instead of calling Workers AI directly.
>
> Before making any AI call, the gateway checks the org's token budget in D1. If they're out, it returns a 429 and the AI call never happens — so we never waste tokens on an org that can't afford it.
>
> If the budget is fine, it picks the right model based on the requested tier — llama-3.2 for standard requests, mistral-7b for quality ones that need better reasoning. Then it calls Workers AI, tracks how many tokens were used in D1, and returns the response with a throttle warning if the org is about to hit their cap.
>
> We centralize this because otherwise every Worker would need its own budget logic, model selection, and token tracking. One change here — like swapping models — affects all features instantly, with no code changes in the feature Workers."

---

## Common Questions & Answers

**Q: What if an org isn't in the `org_budgets` table?**
A: They get unlimited access. `getBudget()` returns `null`, the exhausted check skips, and `throttle_warning` defaults to `false`. We add orgs to the table when we want to start enforcing limits.

**Q: What happens to `tokens_used_this_period` at month end?**
A: Nothing yet. The current implementation only increments. A separate cron Worker (future) will reset the counter monthly. Until then, values accumulate — which is safe (budgets become effectively "lifetime" caps instead of monthly).

**Q: Why not cache responses in KV?**
A: We will. `LMS_CACHE` is provisioned and bound but not used yet. Common queries (like "what are variables in Python?") can be cached to reduce token costs. This is a Week 3–4 optimization after we see real traffic patterns.

**Q: What's the difference between `max_tokens` and the budget cap?**
A: `max_tokens` (1024/2048) limits how long a **single response** can be. The budget cap (100k+) limits total usage **across all calls** for a month. They work together: max_tokens prevents runaway responses, budget prevents runaway usage.

**Q: Why is the Mistral model `-lora` instead of the base model?**
A: Cloudflare deprecated `@cf/mistral/mistral-7b-instruct-v0.2` in favor of the LoRA adapter variant. Same model, same API — just a different deployment method on Cloudflare's infrastructure.
