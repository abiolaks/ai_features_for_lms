# AI Features for LMS

AI-powered features for a Learning Management Platform — built with Cloudflare Workers, Workers AI, and Vectorize. **6/7 workers deployed, 125/125 tests passing.**

## Architecture

```
LMS (Azure Staging) ──REST API──→ AI Workers ──→ Vectorize / Workers AI
                                          │
Learner ──→ AI Tutor / Paths / Recs ──→ AI03 Gateway ──→ LLM (llama-3.2)
```

| Worker | Purpose | URL | Tests |
|--------|---------|-----|-------|
| **ai-gateway** | LLM router — model selection, token budgeting, D1 tracking | Internal (service binding) | 14/14 ✅ |
| **ai-indexing** | Stream VTT → chunk → embed → Vectorize | `ai-indexing.yomi-alarape.workers.dev` | 17/17 ✅ |
| **ai-tutor** | Grounded Q&A — Durable Objects, WebSocket streaming | `ai-tutor.yomi-alarape.workers.dev` | 21/21 ✅ |
| **ai-paths** | Personalized learning paths from LMS data | `ai-paths.yomi-alarape.workers.dev` | 20/20 ✅ |
| **ai-insights** | Post-quiz coaching with review links | `ai-insights.yomi-alarape.workers.dev` | 30/30 ✅ |
| **ai-recommendations** | Enhanced recs + fallback engine, 24h KV cache | `ai-recommendations.yomi-alarape.workers.dev` | 23/23 ✅ |
| **ai-dashboard** | Static Pages site — 6 live worker cards | `ai-dashboard.pages.dev` | Built ⏳ |

## Phase 2 — In Progress (8 deployable slices)

| Issue | Title | Worker |
|-------|-------|--------|
| F03a | Skill-Gap Analysis | `POST /mentor/skill-gap` |
| F03b | Session Prep Insights | `POST /mentor/session-prep` |
| F04a | Bottleneck Detection | `GET /admin/bottlenecks` |
| F04b | Engagement Monitoring | `GET /admin/engagement` |
| F05 | Admin Analytics Narratives | `GET /admin/narrative` |
| F06 | Platform Assistant | `POST /assistant/ask` |
| F07 | Question Generation | `POST /questions/generate` |
| F08 | Quality Checks | `POST /questions/validate` |

## Phase 3 / Deferred

| Issue | Title | Reason |
|-------|-------|--------|
| F02 | Mentor Matching | Blocked on Mentor Directory data product |
| F09 | Assessment Approval Workflow | Split — AI (API) + LMS (UI) |

## Tech Stack

| Component | Choice |
|-----------|--------|
| **Runtime** | Cloudflare Workers (TypeScript) |
| **LLM** | Workers AI (`@cf/meta/llama-3.2-3b-instruct`) |
| **Embeddings** | Workers AI (`@cf/baai/bge-large-en-v1.5`, 1024-dim) |
| **Vector DB** | Cloudflare Vectorize (`lms-lessons`, cosine) |
| **Cache** | Cloudflare KV (`LMS_CACHE`, 24h TTL) |
| **Relational** | Cloudflare D1 (`lms-platform`, org budgets) |
| **Session State** | Durable Objects + SQLite (tutor) |
| **File Storage** | Cloudflare R2 (`lms-content-staging`) |
| **Video** | Cloudflare Stream (VTT captions) |
| **Async Jobs** | Cloudflare Queues (`indexing-jobs`) |
| **Static Hosting** | Cloudflare Pages (dashboard) |
| **Observability** | Workers Logs + structured JSON spans |
| **Testing** | Vitest + `@cloudflare/vitest-pool-workers` |

## Project Structure

```
├── workers/
│   ├── shared/              # Shared modules (8 files)
│   │   ├── cors.ts          # CORS headers + JSON helper
│   │   ├── env.ts           # BaseEnv type
│   │   ├── fetch-lms.ts     # LMS REST client
│   │   ├── gateway.ts       # AI03 call adapter
│   │   ├── lms-data.ts      # Profile/catalog/progress fetchers
│   │   ├── observability.ts # Span helpers
│   │   ├── test-utils.ts    # Mock factories
│   │   └── types.ts         # Shared TypeScript interfaces
│   ├── ai-gateway/          # AI03 — LLM Gateway ✅
│   ├── ai-indexing/         # AI01 — Content Indexing ✅
│   ├── ai-tutor/            # AI04 — Grounded Q&A ✅
│   ├── ai-paths/            # AI06 — Learning Paths ✅
│   ├── ai-insights/         # AI08 — Post-Quiz Insights ✅
│   ├── ai-recommendations/  # AI07 — Recommendations ✅
│   └── ai-dashboard/        # AI13 — Demo Dashboard ⏳
├── Issues/
│   ├── ai/done/             # 7 completed slices
│   ├── ai/                  # AI13 (last pending)
│   ├── future/              # Phase 2/3 (F01–F05)
│   ├── status.json          # Build progress tracker
│   └── README.md            # Slice map + build order
├── docs/
│   ├── lms-api-contract-for-backend.md   # THE authoritative API contract (1259 lines)
│   ├── tech-stack.md                     # Infrastructure, bindings, URLs
│   ├── lms-webhook-integration.md        # Webhook guide for LMS team
│   ├── prd-ai-features-phase-1.md        # Original PRD (delivered)
│   ├── ai-mvp-scope.md                   # MVP scope decisions
│   ├── ai-testing-guide.md               # Testing patterns
│   └── ai-workers-deployment.md          # Deployment log
├── architecture/
│   └── module-architecture.md            # Authoritative architecture doc
├── knowledge.md          # Session knowledge base
├── progress.txt          # Current project state
└── AGENTS.md             # Agent instructions (Cloudflare Workers context)
```

## API Contract

See [docs/lms-api-contract-for-backend.md](docs/lms-api-contract-for-backend.md) — the single authoritative contract.

**Worker endpoints (called by LMS frontend):**

| Worker | Endpoint | Method |
|--------|----------|--------|
| ai-tutor | `/tutor/ask` | POST |
| ai-tutor | `/tutor/clear` | POST |
| ai-tutor | `/tutor/ws?learner_id=` | WebSocket |
| ai-paths | `/paths/generate` | POST |
| ai-recommendations | `/recommendations/dashboard` | GET/POST |
| ai-recommendations | `/recommendations/next` | GET/POST |
| ai-insights | `/insights/generate` | POST |
| ai-indexing | `/index`, `/deindex` | POST (webhook auth) |

## Setup

```bash
# Install deps (per worker)
cd workers/<name> && npm install

# Set secrets (per worker, once)
npx wrangler secret put LMS_GATEWAY_URL      # ai-paths, ai-indexing, ai-recs, ai-insights
npx wrangler secret put LMS_INTERNAL_KEY     # ai-paths, ai-indexing, ai-recs, ai-insights
npx wrangler secret put LMS_WEBHOOK_SECRET   # ai-indexing only

# Deploy
npx wrangler deploy                          # Workers
npx wrangler pages deploy public --project-name ai-dashboard  # Dashboard

# Test
npx vitest run
```

## Infrastructure

| Resource | Type | Purpose | Status |
|----------|------|---------|--------|
| `lms-lessons` | Vectorize (1024-dim) | Embedded lesson content | ✅ |
| `lms-platform` | D1 database | Org token budgets | ✅ |
| `LMS_CACHE` | KV namespace | 24h recommendation cache | ✅ |
| `indexing-jobs` | Queue | Async content indexing | ✅ |
| `lms-content-staging` | R2 bucket | PDF/PPTX storage | ✅ |
| `TutorSession` | Durable Object | Per-learner conversation state | ✅ |
