# Tech Stack — Current

## Stack Overview

```
┌───────────────────────────────────────────────────┐
│                 CLOUDFLARE WORKERS                  │
│                                                    │
│  ┌─ AI Workers ──────────────────────────────────┐ │
│  │  ai-indexing        Content → VTT → Vectorize  │ │
│  │  ai-tutor           Grounded Q&A (Durable Obj)  │ │
│  │  ai-paths           Personalized learning paths │ │
│  │  ai-recommendations Course recommendations      │ │
│  │  ai-insights        Post-quiz insights          │ │
│  │  ai-dashboard       Demo dashboard (Pages)      │ │
│  │  ai-gateway         LLM proxy (Workers AI)      │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Storage ─────────────────────────────────────┐ │
│  │  Vectorize          Vector search (1024-dim)    │ │
│  │  Durable Objects    Per-learner SQLite sessions │ │
│  │  D1                 Org budget tracking (SQL)   │ │
│  │  KV                 Recommendation cache (24h)  │ │
│  │  R2                 Content files (pdf, pptx)   │ │
│  │  Stream             Video hosting + captions    │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Messaging ───────────────────────────────────┐ │
│  │  Queues            indexing-jobs (async index)  │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Observability ───────────────────────────────┐ │
│  │  Workers Logs      Structured JSON logs         │ │
│  │  wrangler tail     Real-time log streaming      │ │
│  └──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────┐
│              EXTERNAL LMS BACKEND                  │
│                                                    │
│  REST API (Python/FastAPI)                         │
│    GET /api/v1/learner/profile                     │
│    GET /api/v1/catalog                             │
│    GET /api/v1/progress/user                       │
│    GET /api/v1/lessons/{id}                        │
│    GET /api/v1/health                              │
│                                                    │
│  Auth: X-API-Key header (shared LMS_INTERNAL_KEY)  │
│  Calls: POST /index on ai-indexing (webhook)       │
└───────────────────────────────────────────────────┘
```

## Component Details

| # | Component | Choice | Why |
|---|---|---|---|
| 1 | **Compute** | Cloudflare Workers | Global edge, zero cold starts, integrated with other CF services. No containers to manage. |
| 2 | **Language** | TypeScript | Native Workers runtime. Shared types across all workers via `workers/shared/`. |
| 3 | **Vector DB** | Cloudflare Vectorize | Managed vector index. 1024-dim from `@cf/baai/bge-large-en-v1.5`. Org isolation via metadata filtering. |
| 4 | **LLM Provider** | Workers AI (`@cf/meta/llama-3.2-3b-instruct`) | Runs on Cloudflare's GPU edge. No API keys. Standard tier for tutor, paths, recs, insights. |
| 5 | **LLM Gateway** | ai-gateway Worker | Service binding — all AI workers call this, never call Workers AI directly. Org-level token tracking. Tier routing (standard/quality). |
| 6 | **Embedding Model** | `@cf/baai/bge-large-en-v1.5` (1024-dim) | Workers AI native. Chunks → embed → Vectorize upsert. Used by ai-indexing and ai-tutor. |
| 7 | **Session State** | Durable Objects + SQLite | Per-learner conversation history. Persists across deploys. Deterministic routing by `learner_id`. |
| 8 | **Relational DB** | Cloudflare D1 | SQLite-compatible. Used by ai-gateway for org-level token budget tracking. Database: `lms-platform`. |
| 9 | **Key-Value Cache** | Cloudflare KV | 24h TTL recommendation cache. Namespace: `LMS_CACHE`. Used by ai-recommendations. |
| 10 | **File Storage** | Cloudflare R2 | Content files (PDF, PPTX, TXT). Bucket: `lms-content-staging`. Accessed by ai-indexing for extraction. |
| 11 | **Video** | Cloudflare Stream | Video hosting, auto-captioning, AI caption generation. VTT fetched via REST API (binding gap). |
| 12 | **Async Jobs** | Cloudflare Queues | `indexing-jobs` queue. Batch size 3, 60s timeout. Retry 3x on failure. Decouples webhook receive from processing. |
| 13 | **Observability** | Workers Logs + `wrangler tail` | Structured JSON spans (`lms.fetch`, `data.fetch`, `path.generate`, `ai_gateway.generate`). Duration tracking on every span. |
| 14 | **CI/CD** | `wrangler deploy` + `wrangler pages deploy` | Workers from CLI. Pages for static dashboard. Secrets via `wrangler secret put`. |
| 15 | **Testing** | Vitest + `cloudflare:test` | Isolated runtime per test. Mock bindings (AI, Stream, Vectorize, Queues, AI_GATEWAY). No external services needed. |

## Model Tiers

| Tier | Model | Used By |
|---|---|---|
| Standard (fast/cheap) | `@cf/meta/llama-3.2-3b-instruct` | Tutor (AI04), Path Gen (AI06), Recs (AI07), Insights (AI08) |
| Quality (capable) | TBD (mistral or larger model) | Assessment Gen, Quality Checks (future) |
| Embeddings | `@cf/baai/bge-large-en-v1.5` | Content Indexing (AI01), Tutor retrieval (AI04) |

## Service-to-Service Communication

```
┌─────────────────────────────────────────────────────────┐
│  LMS Backend (Python)                                   │
│                                                         │
│  On lesson publish:                                     │
│    POST /index ──▶ ai-indexing Worker                   │
│    Header: X-Webhook-Secret: <LMS_WEBHOOK_SECRET>      │
│                                                         │
│  Exposes API for AI Workers to pull data:               │
│    GET /api/v1/learner/profile                          │
│    GET /api/v1/catalog                                  │
│    GET /api/v1/progress/user?userId=<id>                │
│    Header: X-API-Key: <LMS_INTERNAL_KEY>                │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│  ai-indexing Worker                                     │
│                                                         │
│  Receives webhook → pushes to Queue → consumer:         │
│    1. Fetch VTT from Stream (REST API)                  │
│    2. Extract text from WebVTT                          │
│    3. Chunk at ~2000 chars (sentence boundaries)        │
│    4. Embed via Workers AI (bge-large-en-v1.5)          │
│    5. Upsert to Vectorize (lms-lessons index)           │
│                                                         │
│  Also fetches GET /api/v1/lessons/{id} from LMS         │
│    → enriches entity metadata before indexing           │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│  ai-tutor Worker (Durable Object per learner)           │
│                                                         │
│  Learner asks question:                                 │
│    1. Embed question (same model as indexing)           │
│    2. Query Vectorize (topK=5, org filter, lesson scope)│
│    3. Build grounded prompt with retrieved chunks       │
│    4. Call ai-gateway → Workers AI LLM                  │
│    5. Return answer + citations                         │
│                                                         │
│  State: SQLite in DO — conversation history per learner │
│  Streaming: WebSocket (wss://.../tutor/ws?learner_id=)  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  ai-paths Worker                                        │
│                                                         │
│  1. Fetch learner profile from LMS                      │
│  2. Fetch course catalogue from LMS                     │
│  3. Fetch learner progress from LMS                     │
│  4. Build curriculum design prompt                      │
│  5. Call ai-gateway → Workers AI LLM                    │
│  6. Parse + validate path (prereq ordering, dedup)      │
│  7. Fall back to stubs if LMS unreachable               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  ai-recommendations Worker                              │
│                                                         │
│  Two endpoints: /recommendations/dashboard & /next      │
│                                                         │
│  Enhance path (LMS recs present):                       │
│    1. Fetch LMS baseline recs + profile + catalog       │
│    2. For each rec, call ai-gateway for "why this fits" │
│    3. Merge LMS reason + AI explanation                 │
│                                                         │
│  Engine path (LMS recs empty — cold start):             │
│    1. Embed completed course titles (Workers AI)        │
│    2. Query Vectorize (lms-lessons) — content similarity│
│    3. Score candidates via ai-gateway (curriculum advisor)│
│    4. Blend: content × 0.35 + AI × 0.65 (configurable)  │
│    5. Prereq boost (+15) on /next endpoint              │
│                                                         │
│  KV cache: 24h TTL, scoped per {org, learner}.          │
│  Degraded results never cached — recovery is instant.   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  ai-insights Worker                                     │
│                                                         │
│  POST /insights/generate — accepts quiz attempt IDs     │
│                                                         │
│  1. Fetch attempt data from LMS (score, answers, time)  │
│  2. Fetch assessment metadata (title, passing score)    │
│  3. Fetch module lessons for review links               │
│  4. Build analysis prompt (strengths, gaps, pacing)     │
│  5. Call ai-gateway → Workers AI LLM                    │
│  6. Return insight + personalized review links          │
└─────────────────────────────────────────────────────────┘
```

## Service Bindings (Internal)

| Binding | Used By | Points To |
|---------|---------|-----------|
| `AI_GATEWAY` | ai-paths, ai-tutor, ai-recommendations, ai-insights | ai-gateway Worker |
| `VECTORIZE_INDEX` | ai-indexing, ai-tutor, ai-recommendations | `lms-lessons` Vectorize index |
| `INDEXING_QUEUE` | ai-indexing | `indexing-jobs` Queue |
| `TUTOR_SESSION` | ai-tutor | TutorSession Durable Object |
| `STREAM` | ai-indexing | Cloudflare Stream |
| `LMS_CONTENT` | ai-indexing | `lms-content-staging` R2 bucket |
| `LMS_CACHE` | ai-recommendations, ai-dashboard | KV namespace (24h TTL recommendation cache) |

## Workers URL Map

| Worker | Deployed URL | Exposed? |
|--------|-------------|----------|
| ai-indexing | `https://ai-indexing.yomi-alarape.workers.dev` | LMS Backend (webhooks) |
| ai-tutor | `https://ai-tutor.yomi-alarape.workers.dev` | LMS Frontend (browser) |
| ai-paths | `https://ai-paths.yomi-alarape.workers.dev` | LMS Frontend (browser) |
| ai-recommendations | `https://ai-recommendations.yomi-alarape.workers.dev` | LMS Frontend (browser) |
| ai-insights | `https://ai-insights.yomi-alarape.workers.dev` | LMS Frontend (browser) |
| ai-dashboard | `https://ai-dashboard.pages.dev` | LMS Frontend (browser) |
| ai-gateway | Internal only (service binding) | Other Workers |

## Secrets Per Worker

| Secret | Workers That Need It | Purpose |
|--------|---------------------|---------|
| `LMS_GATEWAY_URL` | ai-paths, ai-indexing, ai-recommendations, ai-insights | Base URL for LMS REST API |
| `LMS_INTERNAL_KEY` | ai-paths, ai-indexing, ai-recommendations, ai-insights | Shared key for LMS API auth |
| `LMS_WEBHOOK_SECRET` | ai-indexing | Validates incoming webhook calls from LMS |
| `CLOUDFLARE_STREAM_API_TOKEN` | ai-indexing | Fetches VTT from Stream REST API |
| `CLOUDFLARE_ACCOUNT_ID` | ai-indexing | Stream REST API account path |

## What We're NOT Using (and why)

| Not Using | Because |
|---|---|
| Azure AI Search | Moved to Cloudflare Vectorize — zero config, managed, integrated with Workers |
| Azure OpenAI | Moved to Workers AI — runs on Cloudflare edge, no API keys, no VNet |
| Azure Container Apps | Moved to Cloudflare Workers — global edge, no containers, no cold starts |
| Azure Service Bus | Moved to Cloudflare Queues — integrated with Workers, dead-letter, retry |
| Azure PostgreSQL | Moved to Durable Objects + SQLite — per-learner isolation, no DB server |
| Azure Blob Storage | Moved to Cloudflare R2 — S3-compatible, Workers-native |
| Azure Cache for Redis | Workers KV for recommendation cache + D1 for budget tracking |
| Application Insights | Workers Logs + structured JSON spans + `wrangler tail` |
| Managed Identity | Cloudflare service bindings provide private networking between Workers |
| Bicep / Terraform | `wrangler.jsonc` config + `wrangler deploy` + `wrangler pages deploy` |
