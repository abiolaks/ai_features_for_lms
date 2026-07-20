# Agent Instructions — AI-Powered LMS

## Project Status

**6/7 AI workers complete** + Demo Dashboard. All deployed to Cloudflare Workers (`*.yomi-alarape.workers.dev`). The LMS is an external service hosted on Azure (`lms-staging-api-*.azurewebsites.net`).

## Architecture

```
LMS (Azure Staging)               AI Workers (Cloudflare Edge)         LLM
──────────────────────            ─────────────────────────────       ───────────
REST API                          Cloudflare Workers (TypeScript)      Workers AI

POST /webhook  ──────────→  AI01 Indexing ─→ Stream (VTT) ─→ Vectorize
/v1/lessons/{id}    ←──────  AI04 Tutor ──→ Vectorize ──→ AI03 Gateway ──→ Workers AI
/v1/catalog         ←──────  AI06 Paths ──→ AI03 Gateway ──→ Workers AI
/v1/learner/profile ←──────  AI07 Recs ───→ KV + Vectorize + AI03 ──→ Workers AI
/v1/progress/user   ←──────  AI08 Insights ─→ AI03 Gateway ──→ Workers AI
All workers ────────────────  AI13 Dashboard (Pages)
```

**All AI Workers read from LMS via `GET /api/v1/...` with `LMS_INTERNAL_KEY`.**
**AI03 Gateway is the only Worker that calls Workers AI. All others call AI03 via Service Binding.**
**Vectorize (lms-lessons, 1024-dim, cosine) handles all retrieval.**

Full context and implementation plan is in `Issues/`:
- `Issues/README.md` — structure, slice map, build order
- `Issues/TECH_PRINCIPLES.md` — code conventions, PR rules
- `Issues/ARCHITECTURE.md` — architecture decisions
- `Issues/ai/` — active slice issues
- `Issues/ai/done/` — completed slices
- `Issues/status.json` — build progress tracker

## Tech Stack

| Component | Choice |
|-----------|--------|
| **Compute** | Cloudflare Workers (TypeScript) |
| **LLM** | Workers AI (`@cf/meta/llama-3.2-3b-instruct`) |
| **Embeddings** | Workers AI (`@cf/baai/bge-large-en-v1.5`, 1024-dim) |
| **Vector DB** | Cloudflare Vectorize (`lms-lessons` index) |
| **Cache** | Cloudflare KV (LMS_CACHE, 24h TTL) |
| **Relational** | Cloudflare D1 (`lms-platform`, org budget tracking) |
| **Session State** | Durable Objects + SQLite (tutor) |
| **File Storage** | Cloudflare R2 (`lms-content-staging`) |
| **Video** | Cloudflare Stream (hosting + VTT captions) |
| **Async Jobs** | Cloudflare Queues (`indexing-jobs`) |
| **Observability** | Workers Logs + structured JSON spans + `wrangler tail` |
| **CI/CD** | `wrangler deploy` + `wrangler pages deploy` |
| **Testing** | Vitest + `@cloudflare/vitest-pool-workers` |

### Auth

- **LMS → AI Indexing:** `X-Webhook-Secret` header (validates webhooks)
- **AI Workers → LMS:** `X-API-Key` or `Bearer` token via `LMS_INTERNAL_KEY`
- **AI Workers ↔ AI Gateway:** Service Bindings (private, no auth needed)
- **LMS Frontend → AI Workers:** Open currently — will sit behind LMS Platform Gateway

### Shared Code

- `workers/shared/fetch-lms.ts` — LMS API client (all workers use this)
- `workers/shared/cors.ts` — CORS headers + JSON helper (all frontend-facing workers)
- `workers/shared/types.ts` — shared TypeScript interfaces

### Worker Ports (all Cloudflare-hosted, no local ports)

| Worker | URL | Exposed to |
|--------|-----|------------|
| ai-gateway | Internal (service binding) | Other Workers |
| ai-indexing | `ai-indexing.yomi-alarape.workers.dev` | LMS Backend (webhooks) |
| ai-tutor | `ai-tutor.yomi-alarape.workers.dev` | LMS Frontend |
| ai-paths | `ai-paths.yomi-alarape.workers.dev` | LMS Frontend |
| ai-recommendations | `ai-recommendations.yomi-alarape.workers.dev` | LMS Frontend |
| ai-insights | `ai-insights.yomi-alarape.workers.dev` | LMS Frontend |
| ai-dashboard | `ai-dashboard.pages.dev` | LMS Frontend (Pages) |

### Service Bindings

| Binding | Used By | Points To |
|---------|---------|-----------|
| `AI_GATEWAY` | ai-paths, ai-tutor, ai-recommendations, ai-insights | ai-gateway Worker |
| `VECTORIZE_INDEX` | ai-indexing, ai-tutor, ai-recommendations | `lms-lessons` Vectorize index |
| `INDEXING_QUEUE` | ai-indexing | `indexing-jobs` Queue |
| `TUTOR_SESSION` | ai-tutor | TutorSession Durable Object |
| `LMS_CACHE` | ai-recommendations, ai-dashboard | KV namespace |

### Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/tech-stack.md` | Current infrastructure, all bindings, URL map |
| `docs/lms-api-contract-for-backend.md` | **THE** authoritative API contract |
| `docs/lms-webhook-integration.md` | Webhook integration guide for LMS team |
| `docs/prd-ai-features-phase-1.md` | Original PRD (historical) |
| `docs/ai-mvp-scope.md` | MVP scope decisions, what was cut |
| `docs/ai-testing-guide.md` | Testing patterns for each worker |
| `docs/ai-workers-deployment.md` | Deployment log |
| `docs/lms-api-contract-for-backend.md` | AI services API contract + LMS endpoints |
| `Issues/status.json` | Build progress (6/7 complete) |

### LMS Endpoints Workers Call

| Endpoint | Used By | Notes |
|----------|---------|-------|
| `/api/v1/learner/profile` | ai-paths, ai-recommendations | LMS infers learner from auth context |
| `/api/v1/catalog` | ai-paths, ai-recommendations | LMS infers org from auth context |
| `/api/v1/progress/user?userId=<id>` | ai-paths, ai-recommendations, ai-insights | UUID required |
| `/api/v1/lessons/{id}` | ai-indexing, ai-tutor, ai-insights | Metadata enrichment |
| `/api/v1/courses/recommendations` | ai-recommendations | Baseline recs (staging: returns empty) |
| `/api/v1/learner/assessments/{id}` | ai-insights | Quiz metadata |
| `/api/v1/learner/assessments/attempts/{id}` | ai-insights | Quiz attempt details |
| `/api/v1/modules/{id}/lessons` | ai-insights | Review links |

**Response format:** All endpoints wrap data: `{ success: bool, data: ..., message?: string }`. Workers extract `.data`.

### Deploy Checklist

```bash
# Secrets per worker (set once)
npx wrangler secret put LMS_GATEWAY_URL   # ai-paths, ai-indexing, ai-recommendations, ai-insights
npx wrangler secret put LMS_INTERNAL_KEY  # ai-paths, ai-indexing, ai-recommendations, ai-insights
npx wrangler secret put LMS_WEBHOOK_SECRET     # ai-indexing only
npx wrangler secret put CLOUDFLARE_STREAM_API_TOKEN  # ai-indexing only
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID        # ai-indexing only

# Deploy
cd workers/<name> && npx wrangler deploy    # Workers
cd workers/ai-dashboard && npx wrangler pages deploy public --project-name ai-dashboard  # Pages
```
