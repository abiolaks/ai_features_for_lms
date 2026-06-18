# AI Features — Observability, Evaluation & KPIs

> How we know the AI features are working. Tracing, eval, feedback, and metrics.

---

## The Observability Stack

```
Cloudflare Workers (auto-instrumented)
  │
  ├──→ Workers Traces (free, automatic)
  │      fetch to LMS, fetch to Huawei, KV, D1, Vectorize, DO
  │      → Cloudflare Dashboard: latency, errors, request flows
  │
  ├──→ Custom LLM spans (manual OTel)
  │      prompts, responses, tokens, models, groundedness flags
  │      → OpenInference semantic conventions
  │
  └──→ OTLP Export → Phoenix (for eval + offline analysis)
         OTLP HTTP endpoint: http://localhost:6006/v1/traces
         (or Phoenix Cloud for production)
```

---

## Layer 1: Cloudflare Workers Auto-Tracing (Free, Zero Code)

Every Worker gets this automatically by enabling tracing:

```toml
# wrangler.toml
[observability.traces]
enabled = true
head_sampling_rate = 1.0    # 100% during dev, 5% in prod
```

**What you see for free:**

| Span | Shows | AI Feature Impact |
|------|-------|-------------------|
| `fetch` to LMS | Latency, status code, URL path | Measure LMS API performance per Worker |
| `fetch` to Huawei | Latency, status code, URL | Measure LLM response time |
| KV `get`/`put` | Latency, key pattern, cache hit/miss | Measure recommendation cache performance |
| D1 `query` | SQL text, rows read/written, duration | Measure budget queries, assessment storage |
| Vectorize `query` | Query text, result count | Measure RAG retrieval latency |
| DO operations | KV get/put/delete, SQL exec | Measure conversation history performance |
| Worker invocation | CPU time, wall time, outcome | Overall Worker health |

**Dashboard view:** One trace shows: `POST /tutor/ask → fetch LMS lesson → Vectorize query → fetch Huawei → response`

---

## Layer 2: Custom LLM Spans (Manual, ~20 lines per Worker)

Workers auto-tracing covers infra but doesn't know about LLM semantics. We add manual spans for LLM operations.

```typescript
// In every AI Worker that calls AI03
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('ai-tutor');

async function generateAnswer(messages: Message[], tier: string, orgId: string) {
  return tracer.startActiveSpan('llm.generate', async (span) => {
    span.setAttributes({
      'llm.provider': 'huawei',
      'llm.model': tier === 'quality' ? 'qwen3.6-27b' : 'qwen3.6-flash',
      'llm.input_messages': JSON.stringify(messages),
      'llm.invocation_parameters': JSON.stringify({ tier, temperature: 0.7 }),
      'org.id': orgId,
    });

    const start = Date.now();
    const result = await env.AI_GATEWAY.fetch('https://ai-gateway/generate', {
      method: 'POST',
      body: JSON.stringify({ messages, tier, org_id: orgId }),
    });
    const data = await result.json<GenerateResponse>();

    span.setAttributes({
      'llm.output_messages': JSON.stringify([{ role: 'assistant', content: data.response }]),
      'llm.token_count.prompt': data.tokens_used,
      'llm.token_count.completion': data.tokens_used,
      'llm.response.latency_ms': Date.now() - start,
    });
    span.end();
    return data;
  });
}
```

**What this adds on top of auto-tracing:**
- Model name, provider, tier
- Full prompt and response (redact in prod)
- Token counts
- LLM-specific latency
- Org ID for cost attribution

---

## Layer 3: Phoenix for Evaluation (Offline)

Phoenix excels at evaluation — running LLM judges against traced spans to score quality.

### Setup: Export Worker traces to Phoenix

```toml
# wrangler.toml
[observability.traces]
enabled = true
destinations = ["phoenix-otel"]
head_sampling_rate = 0.10    # 10% sample for eval

# In Cloudflare Dashboard → Observability → Destinations:
# Name: phoenix-otel
# Type: Traces
# OTLP Endpoint: https://your-phoenix.com/v1/traces
# Header: authorization=Bearer ${PHOENIX_API_KEY}
```

### Eval Pipeline

```
1. Worker runs → traces exported to Phoenix
2. Phoenix stores spans with OpenInference attributes
3. Run eval job periodically (daily/weekly):
   - Fetch recent spans from Phoenix
   - Run LLM judge on each span
   - Score: groundedness, relevance, tone, correctness
   - Store scores back as span evaluations
4. View eval dashboard: score trends over time
```

### Eval Script (runs locally, calls Phoenix API)

```python
# evals/run_evals.py — Run daily against Phoenix traces
import phoenix as px
from phoenix.evals import (
    llm_classify,
    HallucinationEvaluator,
    RelevanceEvaluator,
    ToxicityEvaluator,
)

client = px.Client(endpoint="http://localhost:6006")

# Fetch yesterday's tutor spans
spans = client.get_spans(
    project_name="ai-tutor",
    start_time=yesterday,
    span_kind="LLM",
)

# Run groundedness eval: does the answer match the retrieved chunks?
hallucination_eval = HallucinationEvaluator(model="qwen3.6-flash")
hallucination_scores = llm_classify(
    dataframe=spans,
    template=hallucination_eval,
    rails=["grounded", "ungrounded"],
)

# Run relevance eval: does the answer address the question?
relevance_eval = RelevanceEvaluator(model="qwen3.6-flash")
relevance_scores = llm_classify(
    dataframe=spans,
    template=relevance_eval,
    rails=["relevant", "irrelevant"],
)

# Log scores back to Phoenix
px.log_evaluations(
    SpanEvaluations(eval_name="groundedness", dataframe=hallucination_scores),
    SpanEvaluations(eval_name="relevance", dataframe=relevance_scores),
)
```

---

## KPIs Per AI Feature

### AI04 — Tutor

| KPI | Target | How Measured | Alert If |
|-----|--------|-------------|----------|
| **Groundedness** | ≥90% answers grounded in source | Phoenix eval (HallucinationEvaluator) | <80% for 2 consecutive days |
| **Answer relevance** | ≥85% answers address the question | Phoenix eval (RelevanceEvaluator) | <75% |
| **"Not found" accuracy** | ≥95% — doesn't fabricate when no content | Manual spot-check or eval | <90% |
| **Response latency** | P95 < 2 seconds | Workers traces (fetch to Huawei + Vectorize) | P95 > 3s |
| **Scope expansion rate** | % of queries that trigger scope expansion | Custom metric in Worker | >50% (too many narrow misses) |
| **Citation accuracy** | ≥90% citations point to correct section | Manual eval | <85% |

### AI08 — Post-Quiz Insights

| KPI | Target | How Measured | Alert If |
|-----|--------|-------------|----------|
| **Tone compliance** | 100% encouraging, 0% negative/shaming | Phoenix eval (ToxicityEvaluator) | Any toxicity flag |
| **Review link validity** | 100% links point to existing LMS sections | Integration test | Any 404 |
| **Insight actionability** | ≥80% insights include specific review suggestion | LLM judge eval | <70% |
| **Response latency** | P95 < 3 seconds | Workers traces | P95 > 5s |

### AI06 — Learning Paths

| KPI | Target | How Measured | Alert If |
|-----|--------|-------------|----------|
| **Prerequisite ordering** | 100% — no course before its prereq | Automated validation (topological sort check) | Any violation |
| **Path completeness** | 100% — no duplicate or missing courses | Automated validation | Any issue |
| **Personalization relevance** | ≥80% — `why_this_fits` references actual learner data | LLM judge eval | <70% |
| **Degradation handling** | Returns catalogue view when AI unavailable | Integration test | 500 error instead |

### AI07 — Enhanced Recommendations

| KPI | Target | How Measured | Alert If |
|-----|--------|-------------|----------|
| **AI explanation relevance** | ≥80% explanations reference learner's profile | LLM judge eval | <70% |
| **Cache hit rate** | ≥60% (reducing AI03 calls) | KV metrics (get/put ratio) | <40% |
| **Fallback cascade** | 100% — degrades gracefully through 3 tiers | Integration test | Any hard failure |
| **Response latency (cached)** | P95 < 100ms | Workers traces (KV get) | P95 > 500ms |
| **Response latency (uncached)** | P95 < 3 seconds | Workers traces | P95 > 5s |

### AI03 — LLM Gateway

| KPI | Target | How Measured | Alert If |
|-----|--------|-------------|----------|
| **Huawei availability** | ≥99% | Health check (AI12) | <95% |
| **Fallback rate** | <5% of requests fall back to CF AI | Custom metric | >10% |
| **Budget enforcement** | 100% — returns 429 when exhausted | Integration test | Any silent overage |
| **Token tracking accuracy** | 100% — D1 matches actual usage | Reconciliation test | >1% drift |
| **Response latency** | P95 < 1 second (Huawei) | Workers traces | P95 > 2s |

### AI01/02 — Indexing + RAG

| KPI | Target | How Measured | Alert If |
|-----|--------|-------------|----------|
| **Indexing throughput** | 1 lesson indexed within 60 seconds | Workers traces | >120s |
| **Retrieval relevance** | ≥80% chunks relevant to query (top 3) | Manual eval | <70% |
| **Chunk size consistency** | 512 tokens ±15% | Integration test | >20% variance |
| **Org isolation** | 100% — cross-org queries return empty | Integration test | Any cross-org leak |

---

## Feedback Loop — Users Signal Quality

### Inline Feedback (Post-MVP)

```
After each AI response, show:
  👍 Helpful    👎 Not Helpful    ⚑ Report Issue

Stored in D1 feedback table:
  { span_id, feature, rating, comment?, timestamp }
```

### Admin Review Dashboard (Post-MVP)

```
Admin sees:
  - Recent AI responses (tutor answers, insights, paths)
  - Feedback scores
  - Flagged responses
  - Eval scores over time
  - Ability to mark responses as "good example" / "bad example"
```

### Feedback-Driven Improvement

```
1. Collect feedback + traces → Phoenix
2. Identify patterns: "Tutor fabricates when asked about X topic"
3. Create eval dataset from flagged examples
4. Tune prompts or add guardrails
5. Re-run evals → confirm improvement
6. Deploy updated prompt
```

---

## What We Do NOT Need (Yet)

| Tool | Why Not Needed for MVP |
|------|----------------------|
| **Phoenix Cloud** | Local Phoenix is sufficient for eval. Workers auto-tracing covers ops. |
| **Langfuse / LangSmith** | Overkill for 7 Workers. Phoenix + Workers traces is simpler. |
| **Arize AX** | Paid product. Phoenix OSS is free and sufficient. |
| **Custom metrics dashboard** | Cloudflare Dashboard covers metrics. AI13 covers demo. |
| **A/B testing framework** | Post-MVP. Start with before/after eval comparisons. |

---

## MVP Implementation — What to Set Up Week 1

### Step 1: Enable Workers Tracing (5 minutes)

```toml
# In every Worker's wrangler.toml
[observability.traces]
enabled = true
head_sampling_rate = 1.0
```

### Step 2: Add Manual LLM Spans (~20 lines per Worker)

Copy the `tracer.startActiveSpan('llm.generate', ...)` pattern into every Worker that calls AI03. This gives you LLM-specific attributes in every trace.

### Step 3: Set Up Local Phoenix (Week 3, after Tutor ships)

```bash
# Run Phoenix locally
docker run -p 6006:6006 arizephoenix/phoenix:latest

# Export traces from Workers to Phoenix
# Cloudflare Dashboard → Observability → Destinations → Add
# Endpoint: http://your-tunnel.trycloudflare.com:6006/v1/traces
```

### Step 4: Run First Evals (Week 4, after Tutor + Insights ship)

```bash
# Fetch traces → run evals → log scores
python evals/run_evals.py
```

### Step 5: Add Health Dashboard to AI13 (Week 5)

Show live metrics in the demo dashboard:
- Tutor: groundedness score (last 24h), avg latency
- Insights: toxicity score (always green)
- Gateway: budget usage %, Huawei availability

---

## Alert Thresholds Summary

| Severity | Condition | Action |
|----------|-----------|--------|
| 🔴 Critical | Tutor groundedness < 70% | Rollback prompt, investigate RAG |
| 🔴 Critical | Any toxicity detected in Insights | Immediate rollback |
| 🔴 Critical | Budget overage (tokens > cap, no 429) | Fix budget enforcement |
| 🟡 Warning | P95 latency > 3s (any feature) | Check Huawei health, consider CF fallback |
| 🟡 Warning | Fallback rate > 10% | Investigate Huawei stability |
| 🟡 Warning | Cache hit rate < 40% | Tune cache TTL or key strategy |
| 🟢 Info | Scope expansion rate > 50% | Consider improving chunking or retrieval |
