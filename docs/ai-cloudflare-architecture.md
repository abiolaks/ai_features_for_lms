# Cloudflare Workers AI Architecture

> LMS AI features running entirely on Cloudflare Workers. Cloudflare handles infrastructure, embeddings, and LLM inference. No external providers.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                            │
│                                                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ Tutor    │ │ Paths    │ │ Insights │ │ Recs     │            │
│  │ Worker   │ │ Worker   │ │ Worker   │ │ Worker   │            │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘            │
│       │             │            │            │                   │
│       │    ┌────────┴────────────┴────────────┘                  │
│       │    │                                                      │
│       │    │  ┌──────────────────────────────┐                   │
│       │    │  │ AI03 LLM Gateway Worker       │                   │
│       │    │  │   ├── Budget enforcement (D1) │                   │
│       │    │  │   ├── Model selection         │                   │
│       │    │  │   ├── Token tracking          │                   │
│       │    │  │   └── Caching (KV)            │                   │
│       │    │  └──────────┬───────────────────┘                   │
│       │    │             │                                        │
│       │    │      Workers AI                                       │
│       │    │      (env.AI.run)                                     │
│       │    │                                                     │
│  ┌────┴────┴──────────────────────────────────────┐             │
│  │ Infrastructure                                   │             │
│  │  ┌─────────┐ ┌─────────┐ ┌──────┐ ┌──────────┐ │             │
│  │  │ Vectorize│ │ D1      │ │ R2   │ │ KV + DO  │ │             │
│  │  │ (bge-m3) │ │ (SQLite)│ │(files)│ │ Queues  │ │             │
│  │  └─────────┘ └─────────┘ └──────┘ └──────────┘ │             │
│  └──────────────────────────────────────────────────┘             │
│                                                                   │
│  Embeddings: Workers AI bge-m3 (0 egress, ~5ms)                  │
│  LLM standard: Workers AI Llama 3.2                               │
│  LLM quality:  Workers AI Mistral                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## The AI03 Gateway Worker — Central LLM Adapter

Every AI Worker calls `POST https://ai-gateway/generate`. Never Workers AI directly.

```typescript
// ============================================================
// AI03 Gateway Worker
// ============================================================

interface GenerateRequest {
  messages: { role: string; content: string }[];
  tier: 'standard' | 'quality';
  org_id: string;
}

interface GenerateResponse {
  response: string;
  model_used: string;
  provider: 'cloudflare';
  tokens_used: number;
  throttle_warning: boolean;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const body: GenerateRequest = await req.json();

    // 1. Budget check (D1)
    const budget = await checkBudget(body.org_id, env.DB);
    if (budget.exhausted) {
      return Response.json({
        error: 'budget_exhausted',
        message: 'Contact your org admin to increase the budget.'
      }, { status: 429 });
    }

    // 2. Call Workers AI
    const result = await callWorkersAI(body, budget, env);

    // 3. Track tokens (D1)
    await trackTokens(body.org_id, result.tokens_used, env.DB);

    // 4. Return standardized response
    return Response.json(result);
  }
};

// ──── Workers AI Call ────
async function callWorkersAI(
  body: GenerateRequest,
  budget: Budget,
  env: Env
): Promise<GenerateResponse> {
  const model = body.tier === 'quality'
    ? '@cf/mistral/mistral-7b-instruct-v0.2'
    : '@cf/meta/llama-3.2-3b-instruct';

  const result = await env.AI.run(model, {
    messages: body.messages,
    max_tokens: body.tier === 'quality' ? 2048 : 1024,
  });

  return {
    response: result.response,
    model_used: model,
    provider: 'cloudflare',
    tokens_used: result.usage.total_tokens,
    throttle_warning: checkThrottle(budget, result.usage.total_tokens),
  };
}
```

---

## How AI Workers Call the Gateway

Every AI Worker uses the same pattern:

```typescript
// Example: AI06 Learning Paths Worker
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { learner_id, org_id } = await req.json();

    // 1. Fetch data from D1
    const profile = await fetchProfile(learner_id, env.DB);
    const catalogue = await fetchCatalogue(org_id, env.DB);

    // 2. Build the prompt
    const messages = [
      { role: 'system', content: 'You are a curriculum designer...' },
      { role: 'user', content: buildPathPrompt(profile, catalogue) }
    ];

    // 3. Call Gateway — never touch Workers AI directly
    const result = await (await env.AI_GATEWAY.fetch(
      'https://ai-gateway/generate',
      {
        method: 'POST',
        body: JSON.stringify({
          messages,
          tier: 'standard',
          org_id,
        })
      }
    )).json();

    // 4. Parse and return
    const path = parsePathJSON(result.response);
    validatePathOrder(path, catalogue.prerequisites);

    return Response.json({
      ...path,
      ai_status: 'available',
    });
  }
};
```

---

## Model Selection — Per Tier

| Tier | Model | Use Case |
|------|-------|----------|
| **Standard** | `@cf/meta/llama-3.2-3b-instruct` | Tutor Q&A, paths, recs, insights, assistant |
| **Quality** | `@cf/mistral/mistral-7b-instruct-v0.2` | Question generation, complex reasoning |
| **Embeddings** | `@cf/baai/bge-m3` (always) | Chunking, retrieval, duplicate detection |

> The Gateway decides model based on `tier`. AI Workers only pass `tier`.

---

## Wrangler Configuration

```toml
# wrangler.toml

# ──── AI03 Gateway Worker ────
name = "ai-gateway"
main = "ai-gateway/src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "lms-platform"
database_id = "xxxx"

[[kv_namespaces]]
binding = "CACHE"
id = "xxxx"

# ──── AI06 Paths Worker ────
[[services]]
binding = "AI_GATEWAY"
service = "ai-gateway"

# ──── AI04a Tutor Worker ────
[[services]]
binding = "AI_GATEWAY"
service = "ai-gateway"

# ... repeat for all AI Workers

# ──── Vectorize ────
[[vectorize]]
binding = "VECTOR_INDEX"
index_name = "lms-chunks"

# ──── R2 ────
[[r2_buckets]]
binding = "CONTENT_STORE"
bucket_name = "lms-content"

# ──── Queues ────
[[queues]]
binding = "INDEXING_QUEUE"
queue_name = "indexing-jobs"

# ──── Durable Objects ────
[[durable_objects.bindings]]
name = "CONVERSATION_STORE"
class_name = "ConversationStore"
```

---

## What Runs Where

| Layer | Cloudflare | Notes |
|---|---|---|
| **LLM text (standard)** | Workers AI Llama 3.2 | All languages |
| **LLM text (quality)** | Workers AI Mistral | Complex reasoning, question generation |
| **Embeddings** | Workers AI bge-m3 | 0 egress, fast, multilingual |
| **Vector DB** | Vectorize | Metadata filtering for org isolation |
| **SQL DB** | D1 | Courses, profiles, enrollments, quizzes |
| **File storage** | R2 | Raw lesson text, transcripts |
| **Caching** | KV | Recommendations cache, health status |
| **Queues** | Queues | Async indexing jobs |
| **Sessions** | Durable Objects | Conversation history, quiz sessions |
| **Observability** | AI Gateway + Analytics Engine | All LLM calls traced |
| **UI** | Pages | Web Components, static assets |

---

## Data Flow Per Feature

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  AI04a Tutor │    │  AI06 Paths  │    │  AI08 Insights│   │  AI10a Gen   │
│              │    │              │    │              │    │              │
│ 1. Embed     │    │ 1. Query D1  │    │ 1. Query D1  │    │ 1. Embed     │
│    query via  │    │    profile + │    │    quiz data │    │    query via │
│    Workers AI │    │    catalogue │    │ 2. Build     │    │    Workers AI│
│    bge-m3     │    │ 2. Build     │    │    prompt    │    │    bge-m3    │
│ 2. Retrieve   │    │    prompt    │    │ 3. Call      │    │ 2. Retrieve  │
│    chunks     │    │ 3. Call      │    │    Gateway   │    │    chunks    │
│    Vectorize  │    │    Gateway   │    │    → Llama   │    │    Vectorize │
│ 3. Call       │    │    → Llama   │    │    3.2 or    │    │ 3. Call      │
│    Gateway    │    │    3.2 or    │    │    Mistral   │    │    Gateway   │
│    → Llama    │    │    Mistral   │    │ 4. Return    │    │    → Mistral │
│    3.2 or     │    │ 4. Validate  │    │    insight   │    │ 4. Store in  │
│    Mistral    │    │    ordering  │    │              │    │    D1        │
│ 4. Return     │    │ 5. Return    │    │              │    │              │
│    answer +   │    │    path      │    │              │    │              │
│    citations  │    │              │    │              │    │              │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## D1 Schema

```sql
-- Budget tracking
CREATE TABLE org_budgets (
  org_id TEXT PRIMARY KEY,
  monthly_token_cap INTEGER DEFAULT 1000000,
  tokens_used_this_period INTEGER DEFAULT 0,
  billing_period_start INTEGER
);
```

---

## Build Order

```
1. AI03 Gateway Worker     ← Build first (mock mode for dev)
2. AI01a Chunking          ← Workers AI bge-m3 embeddings
3. AI01b Indexing          ← Vectorize + R2 + Queues
4. AI02 RAG Retrieval      ← Vectorize queries
5. AI05 Learner Profile    ← D1 CRUD
6. AI04a Tutor             ← Calls Gateway
7. AI04b Tutor History     ← Durable Objects
8. AI06 Learning Paths     ← Calls Gateway
9. AI07 Recommendations    ← Calls Gateway + KV cache
10. AI08 Post-Quiz Insights ← Calls Gateway
11. AI09 Platform Assistant ← Calls Gateway
12. AI10a Question Gen      ← Calls Gateway (quality tier)
13. AI10b Approval          ← D1 state machine
14. AI11 Quality Checks     ← Workers AI bge-m3 + Gateway for reading level
15. AI12 Fail Gracefully    ← KV health check, Gateway handles degradation
```

---

## Key Principles

1. **Gateway is the single choke point.** No AI Worker ever calls Workers AI directly. Change models in one place.

2. **Embeddings always stay on Workers AI.** bge-m3 is multilingual, low latency, zero egress.

3. **Model selection is tier-driven, not feature-driven.** AI Workers pass `tier` — the Gateway picks the model.

4. **Budget is centralized.** Token counting happens in the Gateway regardless of which model processed the request.

5. **Everything runs on Cloudflare.** Zero external providers. Zero API keys beyond Cloudflare. Zero outbound LLM calls.
