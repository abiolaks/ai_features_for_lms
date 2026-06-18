# Cloudflare + Huawei Multi-Provider Architecture

> LMS AI features running on Cloudflare Workers with Huawei Cloud LLMs for text generation. Cloudflare handles infrastructure and embeddings. Huawei handles LLM inference.

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
│       │    │  │   ├── Provider routing        │                   │
│       │    │  │   ├── Token tracking          │                   │
│       │    │  │   └── Fallback logic          │                   │
│       │    │  └──────────┬───────────────────┘                   │
│       │    │             │                                        │
│       │    │      ┌──────┴──────┐                                │
│       │    │      │             │                                 │
│       │    │  Cloudflare    Huawei                                 │
│       │    │  Workers AI    ModelArts                              │
│       │    │  (no egress)   (fetch outbound)                       │
│       │    │                                                     │
│  ┌────┴────┴──────────────────────────────────────┐             │
│  │ Infrastructure                                   │             │
│  │  ┌─────────┐ ┌─────────┐ ┌──────┐ ┌──────────┐ │             │
│  │  │ Vectorize│ │ D1      │ │ R2   │ │ KV + DO  │ │             │
│  │  │ (bge-m3) │ │ (SQLite)│ │(files)│ │ Queues  │ │             │
│  │  └─────────┘ └─────────┘ └──────┘ └──────────┘ │             │
│  └──────────────────────────────────────────────────┘             │
│                                                                   │
│  Embeddings: always Workers AI bge-m3 (0 egress, ~5ms)           │
│  LLM standard: Huawei Qwen3.6 (Chinese), Llama 3.2 (English)   │
│  LLM quality:  Huawei Qwen3.6 (Chinese), Mistral (English)      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS (fetch)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Huawei Cloud                                  │
│                                                                   │
│  ┌──────────────────────────────────────────────────┐            │
│  │ ModelArts / Qwen API                              │            │
│  │                                                    │            │
│  │  Standard tier → Qwen3.6 (Chinese + English)     │            │
│  │  Quality tier  → Qwen3.6 (complex reasoning)     │            │
│  └──────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────┘
```

---

## The AI03 Gateway Worker — Central Provider Adapter

Every AI Worker calls `POST https://ai-gateway/generate`. Never Huawei directly. Never Workers AI directly.

```typescript
// ============================================================
// AI03 Gateway Worker
// ============================================================

interface GenerateRequest {
  messages: { role: string; content: string }[];
  tier: 'standard' | 'quality';
  org_id: string;
  preferred_language?: string;  // 'en', 'zh', 'ha', 'ig', 'yo', etc.
}

interface GenerateResponse {
  response: string;
  model_used: string;
  provider: 'cloudflare' | 'huawei';
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

    // 2. Decide provider based on language + tier
    const provider = selectProvider(body.preferred_language || 'en', body.tier);

    // 3. Call the selected provider
    let result: GenerateResponse;
    try {
      result = await (provider === 'huawei'
        ? callHuawei(body, budget, env)
        : callCloudflareAI(body, budget, env));
    } catch (err) {
      // 4. Fallback: if Huawei fails, try Cloudflare
      if (provider === 'huawei') {
        console.warn('Huawei unavailable, falling back to Cloudflare AI:', err);
        result = await callCloudflareAI(body, budget, env);
      } else {
        return Response.json({
          error: 'provider_unreachable',
          message: 'AI service temporarily unavailable'
        }, { status: 502 });
      }
    }

    // 5. Track tokens (D1)
    await trackTokens(body.org_id, result.tokens_used, env.DB);

    // 6. Return standardized response
    return Response.json(result);
  }
};

// ──── Provider Selection Logic ────
function selectProvider(language: string, tier: string): 'cloudflare' | 'huawei' {
  // Huawei for Chinese (where Qwen3.6 excels)
  if (language === 'zh') return 'huawei';

  // Cloudflare for English and most languages
  return 'cloudflare';
}

// ──── Huawei API Call ────
async function callHuawei(
  body: GenerateRequest,
  budget: Budget,
  env: Env
): Promise<GenerateResponse> {
  const model = body.tier === 'quality'
    ? env.HUAWEI_QUALITY_MODEL   // 'qwen3.6'
    : env.HUAWEI_STANDARD_MODEL; // 'qwen3.6'

  const response = await fetch(env.HUAWEI_MODELARTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': env.HUAWEI_API_KEY,
    },
    body: JSON.stringify({
      model,
      messages: body.messages,
      max_tokens: body.tier === 'quality' ? 2048 : 1024,
      temperature: 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Huawei API error: ${response.status}`);
  }

  const data = await response.json() as HuaweiResponse;

  return {
    response: data.choices[0].message.content,
    model_used: model,
    provider: 'huawei',
    tokens_used: data.usage.total_tokens,
    throttle_warning: checkThrottle(budget, data.usage.total_tokens),
  };
}

// ──── Cloudflare AI Call ────
async function callCloudflareAI(
  body: GenerateRequest,
  budget: Budget,
  env: Env
): Promise<GenerateResponse> {
  const model = body.tier === 'quality'
    ? '@cf/mistral/mistral-7b-instruct-v0.2'
    : '@cf/meta/llama-3.2-3b-instruct';

  const result = await env.AI.run(model, {
    messages: body.messages,
    max_tokens: 2048,
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

    // 2. Build the prompt (same regardless of provider)
    const messages = [
      { role: 'system', content: 'You are a curriculum designer...' },
      { role: 'user', content: buildPathPrompt(profile, catalogue) }
    ];

    // 3. Call Gateway — never touch Workers AI or Huawei directly
    const result = await (await env.AI_GATEWAY.fetch(
      'https://ai-gateway/generate',
      {
        method: 'POST',
        body: JSON.stringify({
          messages,
          tier: 'standard',
          org_id,
          preferred_language: profile.preferred_language,
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

## Routing Matrix — Which Provider Per Feature

| Feature | Language: English | Language: Chinese | Language: Hausa/Igbo/Yoruba |
|---|---|---|---|
| **AI04a Tutor** | Cloudflare Llama 3.2 | Huawei Qwen3.6 | Cloudflare Llama 3.2 (Phase 2: N-ATLaS) |
| **AI06 Paths** | Cloudflare Llama 3.2 | Huawei Qwen3.6 | Cloudflare Llama 3.2 |
| **AI07 Recs** | Cloudflare Llama 3.2 | Cloudflare Llama 3.2 | Cloudflare Llama 3.2 |
| **AI08 Insights** | Cloudflare Llama 3.2 | Huawei Qwen3.6 | Cloudflare Llama 3.2 |
| **AI09 Assistant** | Cloudflare Llama 3.2 | Huawei Qwen3.6 | Cloudflare Llama 3.2 |
| **AI10a Question Gen** | Cloudflare Mistral | Huawei Qwen3.6 | Cloudflare Mistral |
| **AI01b Embeddings** | Workers AI bge-m3 | Workers AI bge-m3 | Workers AI bge-m3 |
| **AI02 RAG** | Workers AI bge-m3 | Workers AI bge-m3 | Workers AI bge-m3 |
| **AI11 Duplicate** | Workers AI bge-m3 | Workers AI bge-m3 | Workers AI bge-m3 |

> The Gateway decides provider. AI Workers only pass `preferred_language` and `tier`.

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

# Huawei API credentials (secrets)
# npx wrangler secret put HUAWEI_API_KEY
# npx wrangler secret put HUAWEI_MODELARTS_ENDPOINT

[vars]
HUAWEI_STANDARD_MODEL = "qwen3.6"
HUAWEI_QUALITY_MODEL = "qwen3.6"

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

| Layer | Cloudflare | Huawei | Notes |
|---|---|---|---|
| **LLM text (standard)** | Llama 3.2 (English/default) | Qwen3.6 (Chinese) | Route by language |
| **LLM text (quality)** | Mistral (English/default) | Qwen3.6 (Chinese) | Route by language |
| **LLM text (Nigerian)** | Llama 3.2 (fallback) | — | Phase 2: self-host N-ATLaS |
| **Embeddings** | bge-m3 (always) | — | 0 egress, fast, multilingual |
| **Vector DB** | Vectorize (always) | — | Metadata filtering for org isolation |
| **SQL DB** | D1 (always) | — | Courses, profiles, enrollments, quizzes |
| **File storage** | R2 (always) | — | Raw lesson text, transcripts |
| **Caching** | KV (always) | — | Recommendations cache, health status |
| **Queues** | Queues (always) | — | Async indexing jobs |
| **Sessions** | Durable Objects (always) | — | Conversation history, quiz sessions |
| **Observability** | AI Gateway + Analytics Engine | — | Covers Cloudflare calls. Huawei calls logged manually. |
| **UI** | Pages (always) | — | Web Components, static assets |

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
│    Vectorize  │    │    Gateway   │    │    → HUAWEI  │    │    Vectorize │
│ 3. Call       │    │    → HUAWEI  │    │    (zh) or   │    │ 3. Call      │
│    Gateway    │    │    (zh) or   │    │    CF (en)   │    │    Gateway   │
│    → HUAWEI   │    │    CF (en)   │    │ 4. Return    │    │    → HUAWEI  │
│    (zh) or    │    │ 4. Validate  │    │    insight   │    │    Qwen3.6  │
│    CF (en)    │    │    ordering  │    │              │    │    (zh) or   │
│ 4. Return     │    │ 5. Return    │    │              │    │    CF Mistral│
│    answer +   │    │    path      │    │              │    │    (en)      │
│    citations  │    │              │    │              │    │ 4. Store in │
│              │    │              │    │              │    │    D1        │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## D1 Schema Addition

```sql
-- For multi-provider support in org_config
ALTER TABLE org_config ADD COLUMN enabled_providers TEXT DEFAULT '["cloudflare"]';
-- '["cloudflare","huawei"]' when Huawei is active

ALTER TABLE org_config ADD COLUMN provider_rules TEXT DEFAULT '{}';
-- '{"zh":"huawei","en":"cloudflare","ha":"cloudflare","ig":"cloudflare","yo":"cloudflare"}'
```

---

## Cost and Latency Comparison

| Operation | Cloudflare Only | + Huawei (Chinese) |
|---|---|---|
| **Tutor Q&A (English)** | ~200ms | ~200ms (Cloudflare) |
| **Tutor Q&A (Chinese)** | ~200ms (Llama, weak Chinese) | ~400ms (Huawei, strong Chinese) |
| **Embedding** | ~50ms (bge-m3) | ~50ms (unchanged) |
| **Vector search** | ~20ms | ~20ms (unchanged) |
| **Cost per call** | Free tier (100K calls/day) | Huawei API cost + egress data |
| **Infrastructure** | 0 servers | 0 servers (Huawei managed API) |

---

## Build Order

```
1. AI03 Gateway Worker     ← Build first (mock mode for dev)
2. AI01a Chunking          ← Workers AI bge-m3 embeddings
3. AI01b Indexing          ← Vectorize + R2 + Queues
4. AI02 RAG Retrieval      ← Vectorize queries
5. AI05 Learner Profile    ← D1 CRUD
6. AI04a Tutor             ← Calls Gateway (Huawei zh, Cloudflare en)
7. AI04b Tutor History     ← Durable Objects
8. AI06 Learning Paths     ← Calls Gateway
9. AI07 Recommendations    ← Calls Gateway + KV cache
10. AI08 Post-Quiz Insights ← Calls Gateway
11. AI09 Platform Assistant ← Calls Gateway
12. AI10a Question Gen      ← Calls Gateway (quality tier)
13. AI10b Approval          ← D1 state machine
14. AI11 Quality Checks     ← Workers AI bge-m3 + Gateway for reading level
15. AI12 Fail Gracefully    ← KV health check, Gateway handles fallback
```

---

## Key Principles

1. **Gateway is the single choke point.** No AI Worker ever calls Huawei or Workers AI directly. Change providers in one place.

2. **Embeddings always stay on Workers AI.** bge-m3 is multilingual, low latency, zero egress. No reason to route embeddings to Huawei.

3. **Provider selection is language-driven, not feature-driven.** The same Tutor uses Huawei for Chinese and Cloudflare for English. The feature doesn't care which provider it talks to.

4. **Huawei failure = automatic Cloudflare fallback.** The Gateway catches errors, falls back, and logs the event. Learner experience degrades slightly (slower, weaker Chinese) but doesn't break.

5. **Budget is centralized.** Token counting happens in the Gateway regardless of which provider processed the request.
