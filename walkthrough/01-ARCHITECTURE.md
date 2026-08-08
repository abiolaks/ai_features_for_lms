# Part 1: Architecture & Mental Model

## What We're Building

An AI-powered feature layer for a Learning Management System (LMS). The LMS is a Python/FastAPI backend hosted on Azure. These Cloudflare Workers sit between the LMS frontend and AI models, adding 13 intelligent features.

```
Browser ──→ LMS Frontend ──→ Cloudflare Workers ──→ Workers AI (LLMs)
                                  │
                                  ├── Vectorize (embeddings)
                                  ├── D1 (budget tracking)
                                  ├── KV (caching)
                                  ├── R2 (file storage)
                                  ├── Queues (async indexing)
                                  └── Durable Objects (stateful sessions)
```

## The 13 Workers — Three Categories

### Category 1: Infrastructure (2 workers)

| Worker | Purpose | Public? |
|--------|---------|---------|
| **ai-gateway** | LLM router — the only worker that calls Workers AI directly. Token budget tracking in D1. Two LLM tiers. | No (service binding only) |
| **ai-indexing** | Content ingestion — extracts VTT captions from Stream videos, chunks text, embeds via `bge-large-en-v1.5`, upserts to Vectorize. Uses Queue for async processing. | Yes (webhooks from LMS) |

### Category 2: Learner-Facing Features (6 workers)

| Worker | What it does | Key tech |
|--------|-------------|----------|
| **ai-tutor** | Lesson-scoped Q&A. "Explain this concept from lesson 3" | Durable Object (SQLite history), WebSocket streaming, STT → LLM → TTS voice pipeline |
| **ai-assistant** | Platform-wide Q&A. "What courses cover machine learning?" | Durable Object, catalogue-aware RAG, course suggestions |
| **ai-paths** | Personalized learning paths from profile + catalogue + progress | Gateway: standard tier |
| **ai-recommendations** | Dashboard + next-course recommendations with fallback engine | KV cache (24h TTL), content similarity |
| **ai-insights** | Post-quiz coaching + mentor session prep | Quiz analysis, review links |
| **ai-mentor** | Skill-gap analysis | Profile → skills vs catalogue → requirements |

### Category 3: Admin & Content Creation (5 workers)

| Worker | What it does | Key tech |
|--------|-------------|----------|
| **ai-bottlenecks** | Per-module bottleneck detection from aggregate progress/assessment data | Gateway: standard |
| **ai-engagement** | Video drop-off, stall rates, activity patterns | Gateway: standard |
| **ai-analytics** | NL narratives + period comparisons | Gateway: **quality tier** (llama-3.3-70b) |
| **ai-question-gen** | Auto-generate quiz questions from lesson content | Gateway: **quality tier** |
| **ai-quality** | Validate generated questions (accuracy, bias, clarity) | Gateway: standard |

### Bonus: Dashboard

| Worker | Purpose |
|--------|---------|
| **ai-dashboard** | Static Cloudflare Pages site showing 13 worker status cards |

## Core Data Flow

Every learner-facing worker follows the same pattern:

```
1. POST /ask { question, learner_id, org_id }
2. Validate input (length, injection patterns, required fields)
3. Embed question → Workers AI (bge-large-en-v1.5) → 1024-dim vector
4. Query Vectorize → top-K matches filtered by org_id + scope
5. Fetch context from LMS (profile, catalogue, progress — varies by worker)
6. Build prompt: [system rules] + [conversation history] + [retrieved content] + [LMS context] + [question]
7. Call ai-gateway → Workers AI (llama-3.2-3b or llama-3.3-70b)
8. Parse response (JSON or text), extract citations, course suggestions
9. Save exchange to SQLite history (for DO-based workers)
10. Return answer + citations + metadata
11. On any failure → return 200 with degraded stub (never 5xx)
```

## The Gateway Pattern

All 12 frontend workers call the gateway. The gateway is the **only** worker that calls `env.AI.run()`. This gives us:

- **Centralized model selection** — change the model once, everywhere benefits
- **Token budget tracking** — per-org monthly caps in D1
- **Internal-only** — no public URL, called via Cloudflare service bindings
- **Two tiers**: `standard` (llama-3.2-3b, 1024 tokens) and `quality` (llama-3.3-70b, 2048 tokens)

## Content Indexing Pipeline

```
LMS publishes lesson
       │
       ▼
POST /index (webhook, X-Webhook-Secret auth)
       │
       ▼
Queue (INDEXING_QUEUE) — returns 202 immediately
       │
       ▼
Queue consumer:
  1. If video: fetch VTT captions from Cloudflare Stream
     (use existing if available, else generate AI captions)
  2. If PDF: fetch from R2 → extract text with unpdf (per-page)
  3. If PPTX: extract slide text from XML
  5. Chunk text at ~2000 chars (sentence boundaries)
  6. Embed each chunk → Workers AI (bge-large-en-v1.5)
  7. Upsert to Vectorize (lms-lessons index, 1024-dim cosine)
  
POST /deindex → delete all vectors for that lesson
```

Vectorize metadata per chunk:
```json
{
  "title": "Intro to Python",
  "lesson_id": "abc-123",
  "course_id": "course-python",
  "module_id": "mod-1",
  "org_id": "org-acme",
  "content_type": "video",
  "source_type": "video",
  "chunk_index": 0,
  "total_chunks": 5,
  "content": "actual text of this chunk..."
}
```

## LLM Tier Assignment

| Tier | Model | Max Tokens | Used By | Why |
|------|-------|-----------|---------|-----|
| Standard | llama-3.2-3b-instruct | 1024 | tutor, assistant, paths, recs, insights, mentor, bottlenecks, engagement, quality | Fast, cheap, good enough for structured Q&A |
| Quality | llama-3.3-70b-instruct-fp8-fast | 2048 | analytics, question-gen | Higher quality for narratives and quiz creation |
| Embeddings | bge-large-en-v1.5 | — | indexing, tutor, recs, assistant, question-gen | 1024-dim, all content retrieval |

## Key Design Decisions

1. **Durable Objects for state** — each learner gets a dedicated DO with SQLite. Deterministic routing via `idFromName()`. History persists across redeploys.

2. **Degraded mode everywhere** — every external call (LMS, gateway, Vectorize) is try/caught. On failure: return 200 with stub/placeholder. Never propagate 5xx to the LMS frontend.

3. **Service bindings, not URLs** — workers call each other via Cloudflare service bindings. No public URLs for internal services. Lower latency, no auth overhead.

4. **Queue-based async indexing** — video caption extraction takes 5-120s. Queue consumers handle it. LMS gets 202 immediately.

5. **Direct Vectorize, no AI Search** — we manage our own embeddings, chunking, metadata. Full control, no beta instability.

6. **WebSocket streaming** — ai-tutor streams LLM tokens as they're generated. Citations first, then tokens, then TTS audio chunks.
