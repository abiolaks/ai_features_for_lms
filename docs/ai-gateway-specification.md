# AI Gateway Worker — Full Specification

## What the AI Gateway Does

The Gateway is a Worker that sits between every AI feature and Workers AI. Its full responsibilities:

| Responsibility | Detail |
|---|---|
| **Model selection** | `tier=standard` → Llama 3.2; `tier=quality` → Mistral |
| **Budget enforcement** | Per-org monthly token cap. Soft throttle at 80%, hard stop at 100%. Tracks in D1. |
| **Tracing** | Every call traced: model, latency, tokens, status, org |
| **Telemetry** | Metrics to Workers Analytics Engine + structured logs |
| **Caching** | Prompt→response caching in KV (deduplicate identical requests) |
| **Normalization** | Consistent response shape for all AI Workers |
| **Error handling** | Timeouts, budget exhaustion, degraded service signals |

---

## Architecture of the Gateway Itself

```
                          POST /generate
                               │
                    ┌──────────▼──────────┐
                    │  1. Budget Check    │
                    │     (D1)            │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  2. Cache Check     │
                    │     (KV lookup)     │
                    │     Cache hit? → Return immediately
                    └──────────┬──────────┘
                               │ Miss
                    ┌──────────▼──────────┐
                    │  3. Select Model    │
                    │     by tier          │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  4. Workers AI      │
                    │     env.AI.run()    │
                    │     (internal)      │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  5. Cache Store     │
                    │     (KV put, TTL)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  6. Emit Telemetry  │
                    │     Analytics Engine │
                    │     + structured log │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  7. Track Tokens    │
                    │     (D1 UPDATE)     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  8. Return Response │
                    │  { response,         │
                    │    model_used,       │
                    │    tokens_used,      │
                    │    latency_ms }      │
                    └─────────────────────┘
```

---

## Tracing — How to Instrument Every Call  

### Step 1: Analytics Engine Binding

```toml
# wrangler.toml
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "ai_gateway_metrics"
```

### Step 2: Emit a Data Point on Every Call

```typescript
// lib/telemetry.ts

interface CallTelemetry {
  model: string;
  tier: 'standard' | 'quality';
  org_id: string;
  feature: string;          // 'tutor', 'paths', 'insights', etc.
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  status: 'success' | 'error' | 'budget_exhausted';
  cached: boolean;
  error_message?: string;
}

export function emitTelemetry(env: Env, t: CallTelemetry): void {
  env.ANALYTICS.writeDataPoint({
    blobs: [
      t.model,
      t.tier,
      t.org_id,
      t.feature,
      t.status,
      t.error_message || '',
    ],
    doubles: [
      t.latency_ms,
      t.tokens_in,
      t.tokens_out,
      t.tokens_total,
      t.cached ? 1 : 0,
    ],
    indexes: [t.model],
  });
}
```

### Step 3: In the Gateway Handler

```typescript
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const body: GenerateRequest = await req.json();
    const startTime = Date.now();

    let status: CallTelemetry['status'] = 'success';
    let model: string;
    let tokensTotal = 0;

    try {
      // Budget check
      const budget = await checkBudget(body.org_id, env.DB);
      if (budget.exhausted) {
        status = 'budget_exhausted';
        emitTelemetry(env, {
          model: 'none',
          tier: body.tier,
          org_id: body.org_id,
          feature: body.feature || 'unknown',
          latency_ms: Date.now() - startTime,
          tokens_in: 0,
          tokens_out: 0,
          tokens_total: 0,
          status,
          cached: false,
        });
        return budgetExhaustedResponse();
      }

      // Cache check
      const cacheKey = buildCacheKey(body);
      const cached = await env.CACHE.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        emitTelemetry(env, {
          ...parsed.telemetry,
          status: 'success',
          cached: true,
          latency_ms: Date.now() - startTime,
        });
        return Response.json(parsed.response);
      }

      // Select model by tier
      model = selectModel(body.tier);

      // Call Workers AI
      const result = await callWorkersAI(body, model, env);

      // Cache store
      const responsePayload = {
        response: result.response,
        model_used: model,
        tokens_used: result.tokens_used,
        throttle_warning: false,
      };
      await env.CACHE.put(cacheKey, JSON.stringify({
        response: responsePayload,
        telemetry: {
          model, tier: body.tier,
          org_id: body.org_id, feature: body.feature || 'unknown',
          tokens_in: countTokens(body.messages),
          tokens_out: result.tokens_used,
          tokens_total: result.tokens_used,
        }
      }), { expirationTtl: 3600 }); // 1 hour

      // Track tokens
      await trackTokens(body.org_id, result.tokens_used, env.DB);

      // Emit telemetry
      const latencyMs = Date.now() - startTime;
      emitTelemetry(env, {
        model,
        tier: body.tier,
        org_id: body.org_id,
        feature: body.feature || 'unknown',
        latency_ms: latencyMs,
        tokens_in: countTokens(body.messages),
        tokens_out: result.tokens_used,
        tokens_total: result.tokens_used,
        status,
        cached: false,
      });

      // Structured log (for debugging)
      console.log(JSON.stringify({
        event: 'llm_call',
        model,
        tier: body.tier,
        org_id: body.org_id,
        feature: body.feature,
        latency_ms: latencyMs,
        tokens: result.tokens_used,
        status,
        timestamp: Date.now(),
      }));

      return Response.json({
        ...responsePayload,
        throttle_warning: checkThrottle(budget, result.tokens_used),
      });

    } catch (err: any) {
      emitTelemetry(env, {
        model: model || 'unknown',
        tier: body.tier,
        org_id: body.org_id,
        feature: body.feature || 'unknown',
        latency_ms: Date.now() - startTime,
        tokens_in: 0,
        tokens_out: 0,
        tokens_total: 0,
        status: 'error',
        cached: false,
        error_message: err.message,
      });

      return Response.json({
        error: 'provider_unreachable',
        message: 'AI service temporarily unavailable',
        ai_status: 'degraded',
      }, { status: 502 });
    }
  }
};

// ──── Workers AI Call ────
async function callWorkersAI(
  body: GenerateRequest,
  model: string,
  env: Env
): Promise<{ response: string; tokens_used: number }> {
  const result = await env.AI.run(model, {
    messages: body.messages,
    max_tokens: body.tier === 'quality' ? 2048 : 1024,
  });

  return {
    response: result.response,
    tokens_used: result.usage.total_tokens,
  };
}

// ──── Model Selection ────
function selectModel(tier: 'standard' | 'quality'): string {
  return tier === 'quality'
    ? '@cf/mistral/mistral-7b-instruct-v0.2'
    : '@cf/meta/llama-3.2-3b-instruct';
}
```

---

## What Telemetry Gives You

### Query 1: Model Usage Split

```sql
-- Workers Analytics Engine (SQL-like)
SELECT 
  model,
  count() as calls,
  sum(tokens_total) as total_tokens,
  avg(latency_ms) as avg_latency
FROM ai_gateway_metrics
WHERE timestamp > now() - interval '24 hours'
GROUP BY model
```

### Query 2: Error Rate

```sql
SELECT 
  model,
  countif(status = 'error') as errors,
  count() as total,
  (countif(status = 'error') * 100.0 / count()) as error_pct
FROM ai_gateway_metrics
WHERE timestamp > now() - interval '1 hour'
GROUP BY model
```

### Query 3: Per-Feature Token Usage

```sql
SELECT 
  feature,
  model,
  sum(tokens_total) as tokens
FROM ai_gateway_metrics
WHERE timestamp > now() - interval '30 days'
GROUP BY feature, model
```

### Query 4: Availability Over Time

```sql
SELECT 
  date_trunc('hour', timestamp) as hour,
  countif(status = 'success') as success,
  countif(status = 'error') as error,
  countif(status = 'budget_exhausted') as budget_exhausted
FROM ai_gateway_metrics
WHERE timestamp > now() - interval '7 days'
GROUP BY hour
ORDER BY hour
```

---

## Dashboard — What to Monitor

### Real-Time Health (KV + Analytics)

```typescript
// lib/health-dashboard.ts
export async function getHealthSnapshot(env: Env) {
  // Live health check via KV
  const aiHealth = await env.CACHE.get('health:workers-ai');

  return {
    providers: {
      'workers-ai': { status: aiHealth || 'unknown' },
    },
    last_5_minutes: {
      total_calls: await queryAnalytics('count()', '5m'),
      error_rate: await queryAnalytics('error_pct', '5m'),
      avg_latency: await queryAnalytics('avg(latency_ms)', '5m'),
    }
  };
}
```

Health probe runs every 30 seconds as a Cron Trigger:

```toml
# wrangler.toml
[triggers]
crons = ["*/30 * * * *"]
```

```typescript
// health-check worker (scheduled)
export default {
  async scheduled(controller: ScheduledController, env: Env) {
    // Probe Workers AI
    const aiOk = await probeWorkersAI(env);
    await env.CACHE.put('health:workers-ai', aiOk ? 'available' : 'degraded', 
      { expirationTtl: 60 });
  }
};
```

---

## Verification Checklist

### Pre-Launch

- [ ] **Mock mode:** Gateway works with `LLM_PROVIDER=mock` — echoes prompts, returns synthetic tokens
- [ ] **Model selection:** tier=standard → Llama 3.2. tier=quality → Mistral. Verified in logs.
- [ ] **Budget enforcement:** 80% → throttle warning in response. 100% → 429 with admin message.
- [ ] **Cache:** Identical prompts within TTL → KV cache hit. Second call <5ms (vs ~200ms).
- [ ] **Telemetry:** Every call emits an Analytics Engine data point. Queryable within 60 seconds.
- [ ] **Token counting:** Accurate. D1 `tokens_used_this_period` incrementing correctly.
- [ ] **Timeout:** Workers AI hangs → Gateway returns 502 after 30s, doesn't crash the Worker.

### Post-Launch Monitoring

- [ ] **Latency P50/P95:** Tracked via Analytics Engine dashboard
- [ ] **Error rate:** Alerts if >5% of calls fail
- [ ] **Budget alerts:** Org approaching 80% cap triggers notification
- [ ] **Token burn rate:** Overall platform tokens/day vs monthly caps

### Integration Tests

```typescript
// tests/ai-gateway.test.ts
describe('AI03 Gateway', () => {
  it('selects Llama 3.2 for standard tier', async () => {
    const res = await gateway.fetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is ML?' }],
        tier: 'standard',
        org_id: 'org-1',
      })
    });
    const data = await res.json();
    expect(data.model_used).toContain('llama');
  });

  it('selects Mistral for quality tier', async () => {
    const res = await gateway.fetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Generate 10 quiz questions about ML.' }],
        tier: 'quality',
        org_id: 'org-1',
      })
    });
    const data = await res.json();
    expect(data.model_used).toContain('mistral');
  });

  it('rejects when budget exhausted', async () => {
    // Set org tokens_used = monthly_cap
    await env.DB.prepare(
      'UPDATE org_config SET tokens_used_this_period = monthly_token_cap WHERE org_id = ?'
    ).bind('org-1').run();

    const res = await gateway.fetch('/generate', { /* ... */ });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('budget_exhausted');
  });

  it('emits telemetry for every call', async () => {
    const before = await getMetricCount('ai_gateway_metrics');

    await gateway.fetch('/generate', { /* ... */ });

    // Wait for eventual consistency
    await sleep(2000);

    const after = await getMetricCount('ai_gateway_metrics');
    expect(after).toBeGreaterThan(before);
  });

  it('caches identical prompts', async () => {
    const prompt = { messages: [{ role: 'user', content: 'test' }], tier: 'standard', org_id: 'org-1' };

    const res1 = await gateway.fetch('/generate', { method: 'POST', body: JSON.stringify(prompt) });
    const res2 = await gateway.fetch('/generate', { method: 'POST', body: JSON.stringify(prompt) });

    // Second call should be cached (response identical, lower latency)
    expect(await res1.json()).toEqual(await res2.json());
  });
});
```

---

## Difference: Gateway Worker vs Cloudflare AI Gateway

| | Cloudflare AI Gateway | Your AI03 Gateway Worker |
|---|---|---|
| **What it covers** | Only Workers AI calls (`env.AI.run()`) | Workers AI calls through the Gateway |
| **Caching** | Automatic prompt caching | Custom KV-based cache |
| **Rate limiting** | Automatic per-model | Custom per-org budget in D1 |
| **Analytics** | Built-in dashboard | Custom via Analytics Engine |
| **Provider abstraction** | None (only Workers AI) | Single entry point for all AI Workers |
| **Error handling** | Basic | Graceful degradation, budget exhaustion signals |

They don't replace each other — they **stack**. Cloudflare AI Gateway handles Workers AI calls automatically. Your Gateway Worker sits on top, adding model selection, budget enforcement, caching, and per-org tracking.

```
AI Workers → Your Gateway Worker → Cloudflare AI Gateway → Workers AI Llama/Mistral
```

Cloudflare AI Gateway gives you free caching and analytics. Your Gateway Worker gives you the abstraction layer, budget enforcement, and centralized token tracking.
