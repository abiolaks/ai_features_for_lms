# AI03: LLM Gateway Worker

- **Type:** AFK
- **Week:** 1
- **Blocked by:** LMS internal key, Cloudflare Tunnel to LMS
- **PR target:** ~250 lines

## What to build

The single entry point for all LLM calls. Every AI Worker calls this Worker via Service Binding — never calls Workers AI directly.

**One endpoint:**

`POST /generate` — body: `{ messages, tier: "standard"|"quality", org_id }`
→ response: `{ response, model_used, provider: "cloudflare", tokens_used, throttle_warning }`

**Behavior:**
1. Check org budget in D1 (`org_budgets` table) → reject with 429 if exhausted
2. Select model by tier:
   - Standard tier → `@cf/meta/llama-3.2-3b-instruct`
   - Quality tier → `@cf/mistral/mistral-7b-instruct-v0.2`
3. Call Workers AI via `env.AI.run()`
4. Track tokens in D1 (`tokens_used_this_period += tokens_used`)
5. Return standardized response

**D1 schema:**
```sql
CREATE TABLE org_budgets (
  org_id TEXT PRIMARY KEY,
  monthly_token_cap INTEGER DEFAULT 1000000,
  tokens_used_this_period INTEGER DEFAULT 0,
  billing_period_start INTEGER
);
```

**Workers AI call:**
```typescript
const model = body.tier === 'quality'
  ? '@cf/mistral/mistral-7b-instruct-v0.2'
  : '@cf/meta/llama-3.2-3b-instruct';

const result = await env.AI.run(model, {
  messages: body.messages,
  max_tokens: body.tier === 'quality' ? 2048 : 1024,
});
```

## Acceptance criteria

- [ ] `POST /generate` with valid org → calls Workers AI, returns AI response + token count
- [ ] Tier=standard → `@cf/meta/llama-3.2-3b-instruct`, tier=quality → `@cf/mistral/mistral-7b-instruct-v0.2`
- [ ] Budget exhausted → returns 429 `{ error: "budget_exhausted" }`
- [ ] 5 calls → D1 `tokens_used_this_period` reflects cumulative usage
- [ ] `wrangler dev` works with Cloudflare Tunnel → call from curl → get AI response
- [ ] Unit tests: budget enforcement, tier routing, token tracking, caching
- [ ] **Observability:** Workers AI calls auto-traced (latency, status) in CF Dashboard
- [ ] **Observability:** Manual LLM spans include model name, tier, tokens, org_id
- [ ] **Observability:** Budget exhaustion → 429 visible in trace with `error: true`
