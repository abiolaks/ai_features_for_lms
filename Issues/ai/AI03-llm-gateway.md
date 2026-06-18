# AI03: LLM Gateway Worker

- **Type:** AFK
- **Week:** 1
- **Blocked by:** Huawei API key, LMS internal key, Cloudflare Tunnel to LMS
- **PR target:** ~300 lines

## What to build

The single entry point for all LLM calls. Every AI Worker calls this Worker via Service Binding — never calls Huawei directly.

**One endpoint:**

`POST /generate` — body: `{ messages, tier: "standard"|"quality", org_id }`
→ response: `{ response, model_used, provider: "huawei"|"cloudflare", tokens_used, throttle_warning }`

**Behavior:**
1. Check org budget in D1 (`org_budgets` table) → reject with 429 if exhausted
2. Route to provider:
   - Standard tier → `qwen3.6-flash` on Huawei ModelArts
   - Quality tier → `qwen3.6-27b` on Huawei ModelArts
3. If Huawei fails (timeout, 5xx) → fallback to Cloudflare Workers AI
   - Standard fallback: `@cf/meta/llama-3.2-3b-instruct`
   - Quality fallback: `@cf/mistral/mistral-7b-instruct-v0.2`
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

**Huawei API call:**
```typescript
const response = await fetch(env.HUAWEI_MODELARTS_ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Auth-Token': env.HUAWEI_API_KEY },
  body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0.7 }),
  signal: AbortSignal.timeout(30000),
});
```

## Acceptance criteria

- [ ] `POST /generate` with valid org → routes to Huawei Qwen3.6, returns AI response + token count
- [ ] Tier=standard → `qwen3.6-flash`, tier=quality → `qwen3.6-27b`
- [ ] Budget exhausted → returns 429 `{ error: "budget_exhausted" }`
- [ ] Huawei unavailable → auto-fallback to Cloudflare Workers AI, response still works
- [ ] 5 calls → D1 `tokens_used_this_period` reflects cumulative usage
- [ ] `wrangler dev` works with Cloudflare Tunnel → call from curl → get AI response
- [ ] Unit tests: budget enforcement, fallback path, token tracking, provider routing
- [ ] **Observability:** Huawei fetch spans auto-traced (latency, status) in CF Dashboard
- [ ] **Observability:** Manual LLM spans include model name, tier, tokens, org_id
- [ ] **Observability:** Budget exhaustion → 429 visible in trace with `error: true`
