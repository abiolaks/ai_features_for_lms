# Architecture — AI Features for LMS

How the AI workers fit together and how data flows through the system.

## Overall Architecture

```
                         ┌──────────────────────┐
                         │   LMS (Backend Eng)   │
                         │   Not our concern     │
                         └──────┬───────────────┘
                                │
                    webhooks    │  learner questions
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 │                 ▼
    ┌─────────────────┐         │       ┌─────────────────┐
    │   ai-indexing    │         │       │    ai-tutor     │
    │                  │         │       │                 │
    │ Stream → VTT     │         │       │ Embed question  │
    │ Embed → Vectorize│         │       │ Query Vectorize │
    └────────┬─────────┘         │       │ Build prompt    │
             │                   │       │ Call AI Gateway │
             │ upsert            │       └────────┬────────┘
             ▼                   │                │
    ┌─────────────────┐          │       ┌────────▼────────┐
    │    Vectorize     │          │       │   ai-gateway    │
    │  lms-lessons    │◄─────────┘       │                 │
    │  1024-dim       │                  │ Model routing   │
    │  cosine metric  │                  │ Token budgeting │
    └─────────────────┘                  │ D1 tracking     │
                                         └────────┬────────┘
                                                  │
                                                  ▼
                                         ┌─────────────────┐
                                         │   Workers AI    │
                                         │ llama-3.2       │
                                         │ mistral-7b      │
                                         │ qwen3-embedding │
                                         └─────────────────┘
```

## Workers

| Worker | Purpose | Status | URL |
|--------|---------|--------|-----|
| **ai-gateway** | LLM choke point — model selection, token budget, D1 tracking | ✅ | `ai-gateway.yomi-alarape.workers.dev` |
| **ai-indexing** | Extract transcripts from Stream, embed, upsert to Vectorize | ✅ | `ai-indexing.yomi-alarape.workers.dev` |
| **ai-tutor** | Grounded Q&A — embed question, query Vectorize, build prompt, call gateway | ✅ | `ai-tutor.yomi-alarape.workers.dev` |
| ai-recommendations | Course recommendations with fallback cascade | ⬜ | — |
| ai-paths | Personalized learning path generation | ⬜ | — |
| ai-insights | Post-quiz insights with review links | ⬜ | — |
| ai-dashboard | Demo dashboard for all AI features | ⬜ | — |

## Data Flow: Content Ingestion

```
LMS publishes a course
        │
        ▼
POST /index  { event, org_id, entity: { id, title, contentType, cloudflareVideoId, streamStatus, course_id } }
        │
        ▼
┌───────────────────────────────────────────────┐
│ ai-indexing                                   │
│                                               │
│ 1. Check streamStatus === "ready"              │
│ 2. Fetch captions via Stream binding           │
│    ├── Captions exist → fetch VTT (REST API)  │
│    └── No captions → generate AI captions     │
│ 3. ExtractTextFromVTT() → clean transcript    │
│ 4. env.AI.run("@cf/qwen/qwen3-embedding-0.6b")│
│    → 1024-dim vector                           │
│ 5. env.VECTORIZE_INDEX.upsert([{              │
│      id: "lesson-{id}",                       │
│      values: vector,                          │
│      metadata: { title, lesson_id, course_id, │
│        org_id, content, transcript_source }   │
│    }])                                         │
└───────────────────────────────────────────────┘
```

## Data Flow: Learner Question

```
Learner asks: "What is a variable?"
        │
        ▼
POST /tutor/ask  { question, lesson_id, course_id, org_id }
        │
        ▼
┌───────────────────────────────────────────────┐
│ ai-tutor                                      │
│                                               │
│ 1. env.AI.run(embedding_model, { text })       │
│    → 1024-dim query vector                    │
│                                               │
│ 2. env.VECTORIZE_INDEX.query(vector, {        │
│      topK: 5, returnMetadata: true            │
│    })                                          │
│    → [{ id, score, metadata: { title,         │
│         content, lesson_id, ... } }]          │
│                                               │
│ 3. Post-filter: score ≥ 0.1 + lesson_id match │
│    (until Vectorize metadata indexes ready)   │
│                                               │
│ 4. Build grounded prompt:                     │
│    "Answer based on provided content..."      │
│    + [Lesson: Title] excerpt chunks           │
│                                               │
│ 5. env.AI_GATEWAY.fetch(POST /generate)        │
│    → { response, model_used, tokens_used }    │
│                                               │
│ 6. Return: { answer, citations,               │
│      scope_expansion_suggested }              │
└───────────────────────────────────────────────┘
```

## Service Binding Graph

```
ai-tutor ──service binding──→ ai-gateway
    │                              │
    │                              ├── Workers AI (LLM)
    │                              └── D1 (budgets)
    │
    ├── Workers AI (embedding)
    └── Vectorize (query)

ai-indexing
    ├── Workers AI (embedding)
    ├── Vectorize (upsert/delete)
    └── Cloudflare Stream (captions + VTT)
```

## Infrastructure

| Resource | Type | Purpose |
|----------|------|---------|
| `lms-lessons` | Vectorize Index | 1024-dim cosine, metadata indexed (lesson_id, org_id, course_id, module_id) |
| `lms-platform` | D1 Database | Token budgets per org |
| `LMS_CACHE` | KV Namespace | Response caching |
| `indexing-jobs` | Queue | Async video indexing |
| `lms-indexing-source` | R2 Bucket | Provisioned, not used (replaced by direct Vectorize) |

## Scope Expansion Flow

```
Default: lesson scope
  filter: { lesson_id, org_id }
    │
    ├── Content found → return answer
    └── No content → scope_expansion_suggested: true
                      │
                      ▼
                  Module scope
                  filter: { module_id, course_id, org_id }
                      │
                      ├── Content found → return answer
                      └── No content → scope_expansion_suggested: true
                                        │
                                        ▼
                                    Course scope
                                    filter: { course_id, org_id }
```

## LMS Integration Points

Three `LMS_INTEGRATION` markers in the codebase (search to find them):

1. `ai-indexing/src/index.ts` — webhook signature verification
2. `ai-indexing/src/index.ts` — LMS API metadata enrichment
3. `ai-tutor/src/index.ts` — LMS API lesson metadata for citations

Each shows exactly what to uncomment and which secrets to set when the LMS is live.
