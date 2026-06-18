# AI Gateway Worker — Full Specification

## What the AI Gateway Does

The Gateway is a Worker that sits between every AI feature and every LLM provider. Its full responsibilities:

| Responsibility | Detail |
|---|---|
| **Provider routing** | Huawei for Chinese, Cloudflare for English, based on `preferred_language` |
| **Model selection** | `tier=standard` → Pangu-3.0 / Llama 3.2; `tier=quality` → Pangu-38B / Mistral |
| **Budget enforcement** | Per-org monthly token cap. Soft throttle at 80%, hard stop at 100%. Tracks in D1. |
| **Fallback** | Huawei down → auto-fallback to Cloudflare AI |
| **Tracing** | Every call traced: provider, model, latency, tokens, status, org |
| **Telemetry** | Metrics to Workers Analytics Engine + structured logs |
| **Caching** | Prompt→response caching in KV (deduplicate identical requests) |
| **Auth** | Validates org has `enabled_providers` including the requested provider |
| **Normalization** | All providers return identical response shape regardless of backend |

---

## Architecture of the Gateway Itself

```
                          POST /generate
                               │
                    ┌──────────▼──────────┐
                    │  1. Auth + Budget    │
                    │     Check (D1)       │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  2. Cache Check     │
                    │     (KV lookup)     │
                    │     Cache hit? → Return immediately
                    └──────────┬──────────┘
                               │ Miss
                    ┌──────────▼──────────┐
                    │  3. Select Provider │
                    │     by language      │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼───────┐ ┌─────▼──────┐ ┌──────▼────────┐
     │ Cloudflare     │ │ Huawei     │ │ N-ATLaS       │
     │ env.AI.run()   │ │ fetch()    │ │ fetch()        │
     │ (internal)     │ │ (outbound) │ │ (Phase 2)      │
     └────────┬───────┘ └─────┬──────┘ └──────┬────────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  4. Cache Store     │
                    │     (KV put, TTL)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  5. Emit Telemetry  │
                    │     Analytics Engine │
                    │     + structured log │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  6. Track Tokens    │
                    │     (D1 UPDATE)     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  7. Return Response │
                    │  { response,         │
                    │    model_used,       │
                    │    provider,         │
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
  provider: 'cloudflare' | 'huawei' | 'natlas';
  model: string;
  tier: 'standard' | 'quality';
  org_id: string;
  feature: string;          // 'tutor', 'paths', 'insights', etc.
  language: string;          // 'en', 'zh', 'ha', etc.
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  status: 'success' | 'fallback' | 'error' | 'budget_exhausted';
  cached: boolean;
  error_message?: string;
}

export function emitTelemetry(env: Env, t: CallTelemetry): void {
  env.ANALYTICS.writeDataPoint({
    blobs: [
      t.provider,
      t.model,
      t.tier,
      t.org_id,
      t.feature,
      t.language,
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
    indexes: [t.provider],
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
    let provider: string;
    let model: string;
    let tokensTotal = 0;

    try {
      // Budget check
      const budget = await checkBudget(body.org_id, env.DB);
      if (budget.exhausted) {
        status = 'budget_exhausted';
        emitTelemetry(env, {
          provider: 'none',
          model: 'none',
          tier: body.tier,
          org_id: body.org_id,
          feature: body.feature || 'unknown',
          language: body.preferred_language || 'en',
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

      // Select provider
      provider = selectProvider(body.preferred_language || 'en');
      model = selectModel(provider, body.tier);

      // Call provider
      let result: CallResult;
      try {
        result = provider === 'huawei'
          ? await callHuawei(body, env)
          : await callCloudflareAI(body, env);
      } catch (err) {
        if (provider === 'huawei') {
          // Fallback to Cloudflare
          provider = 'cloudflare';
          model = selectModel('cloudflare', body.tier);
          result = await callCloudflareAI(body, env);
          status = 'fallback';
        } else {
          status = 'error';
          throw err;
        }
      }

      // Cache store
      const responsePayload = {
        response: result.response,
        model_used: model,
        provider,
        tokens_used: result.tokens_used,
        throttle_warning: false,
      };
      await env.CACHE.put(cacheKey, JSON.stringify({
        response: responsePayload,
        telemetry: {
          provider, model, tier: body.tier,
          org_id: body.org_id, feature: body.feature || 'unknown',
          language: body.preferred_language || 'en',
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
        provider,
        model,
        tier: body.tier,
        org_id: body.org_id,
        feature: body.feature || 'unknown',
        language: body.preferred_language || 'en',
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
        provider,
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
        provider: provider || 'unknown',
        model: model || 'unknown',
        tier: body.tier,
        org_id: body.org_id,
        feature: body.feature || 'unknown',
        language: body.preferred_language || 'en',
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
```

---

## What Telemetry Gives You

### Query 1: Provider Usage Split

```sql
-- Workers Analytics Engine (SQL-like)
SELECT 
  provider,
  count() as calls,
  sum(tokens_total) as total_tokens,
  avg(latency_ms) as avg_latency
FROM ai_gateway_metrics
WHERE timestamp > now() - interval '24 hours'
GROUP BY provider
```

### Query 2: Error Rate by Provider

```sql
SELECT 
  provider,
  countif(status = 'error') as errors,
  countif(status = 'fallback') as fallbacks,
  count() as total,
  (countif(status = 'error') * 100.0 / count()) as error_pct
FROM ai_gateway_metrics
WHERE timestamp > now() - interval '1 hour'
GROUP BY provider
```

### Query 3: Per-Feature Cost

```sql
SELECT 
  feature,
  provider,
  sum(tokens_total) as tokens,
  sum(tokens_total) * 
    CASE WHEN provider = 'huawei' THEN 0.000002  -- $2/M tokens
         ELSE 0.000000  -- free tier
    END as estimated_cost
FROM ai_gateway_metrics
WHERE timestamp > now() - interval '30 days'
GROUP BY feature, provider
```

### Query 4: Huawei Availability

```sql
SELECT 
  date_trunc('hour', timestamp) as hour,
  countif(status = 'success') as success,
  countif(status = 'fallback') as fallback,
  countif(status = 'error') as error
FROM ai_gateway_metrics
WHERE provider = 'huawei'
  AND timestamp > now() - interval '7 days'
GROUP BY hour
ORDER BY hour
```

---

## Dashboard — What to Monitor

### Real-Time Health (KV + Analytics)

```typescript
// lib/health-dashboard.ts
export async function getHealthSnapshot(env: Env) {
  // Last 5 minutes stats from Analytics Engine
  // (sampled — Analytics Engine is eventually consistent)
  
  // Fallback: live health check via KV
  const huaweiHealth = await env.CACHE.get('health:huawei');
  const cloudflareHealth = await env.CACHE.get('health:cloudflare');

  return {
    providers: {
      cloudflare: { status: cloudflareHealth || 'unknown' },
      huawei: { status: huaweiHealth || 'unknown' },
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
    // Probe Huawei
    const huaweiOk = await probeHuawei(env);
    await env.CACHE.put('health:huawei', huaweiOk ? 'available' : 'degraded', 
      { expirationTtl: 60 });

    // Probe Cloudflare AI
    const cfOk = await probeCloudflare(env);
    await env.CACHE.put('health:cloudflare', cfOk ? 'available' : 'degraded',
      { expirationTtl: 60 });
  }
};
```

---

## Verification Checklist

### Pre-Launch

- [ ] **Mock mode:** Gateway works with `LLM_PROVIDER=mock` — echoes prompts, returns synthetic tokens
- [ ] **Provider routing:** Chinese query → Huawei. English query → Cloudflare. Verified in logs.
- [ ] **Budget enforcement:** 80% → throttle warning in response. 100% → 429 with admin message.
- [ ] **Fallback:** Kill Huawei endpoint → Gateway auto-falls-back to Cloudflare. Response still works.
- [ ] **Cache:** Identical prompts within TTL → KV cache hit. Second call <5ms (vs ~200ms).
- [ ] **Telemetry:** Every call emits an Analytics Engine data point. Queryable within 60 seconds.
- [ ] **Token counting:** Accurate for both providers. D1 `tokens_used_this_period` incrementing correctly.
- [ ] **Timeout:** Huawei hangs → Gateway returns 502 after 30s, doesn't crash the Worker.

### Post-Launch Monitoring

- [ ] **Huawei latency P50/P95:** Tracked via Analytics Engine dashboard
- [ ] **Fallback rate:** Alerts if >5% of Huawei calls fall back to Cloudflare
- [ ] **Budget alerts:** Org approaching 80% cap triggers notification
- [ ] **Cost tracking:** Estimated spend per provider per day
- [ ] **Token burn rate:** Overall platform tokens/day vs monthly caps

### Integration Tests

```typescript
// tests/ai-gateway.test.ts
describe('AI03 Gateway', () => {
  it('routes Chinese to Huawei', async () => {
    const res = await gateway.fetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: '什么是机器学习?' }],
        tier: 'standard',
        org_id: 'org-1',
        preferred_language: 'zh',
      })
    });
    const data = await res.json();
    expect(data.provider).toBe('huawei');
    expect(data.model_used).toContain('pangu');
  });

  it('routes English to Cloudflare', async () => {
    const res = await gateway.fetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What is ML?' }],
        tier: 'standard',
        org_id: 'org-1',
        preferred_language: 'en',
      })
    });
    const data = await res.json();
    expect(data.provider).toBe('cloudflare');
    expect(data.model_used).toContain('llama');
  });

  it('falls back to Cloudflare when Huawei is down', async () => {
    // Mock Huawei endpoint to return 500
    env.HUAWEI_MODELARTS_ENDPOINT = 'http://localhost:9999/broken';

    const res = await gateway.fetch('/generate', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: '什么是机器学习?' }],
        tier: 'standard',
        org_id: 'org-1',
        preferred_language: 'zh',
      })
    });
    const data = await res.json();
    expect(data.provider).toBe('cloudflare');  // Fell back
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
| **What it covers** | Only Workers AI calls (`env.AI.run()`) | **All** LLM calls — Cloudflare + Huawei + N-ATLaS |
| **Caching** | Automatic prompt caching | Custom KV-based cache |
| **Rate limiting** | Automatic per-model | Custom per-org budget in D1 |
| **Analytics** | Built-in dashboard | Custom via Analytics Engine |
| **Fallback** | Not supported | Automatic Huawei → Cloudflare |
| **Provider abstraction** | None (only Workers AI) | Cloudflare / Huawei / N-ATLaS transparent to callers |

They don't replace each other — they **stack**. Cloudflare AI Gateway handles Workers AI calls automatically. Your Gateway Worker sits on top, adding multi-provider routing, budget, and fallback.

```
AI Workers → Your Gateway Worker → Cloudflare AI Gateway → Workers AI Llama/Mistral
                                 → fetch() → Huawei ModelArts → Pangu
```

Cloudflare AI Gateway gives you free caching and analytics for the Workers AI leg. Your Gateway Worker gives you the multi-provider abstraction, budget, and Huawei fallback.
