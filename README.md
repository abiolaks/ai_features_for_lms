# AI Features for LMS

AI-powered features for a Learning Management Platform — built with Cloudflare Workers, Workers AI, and Vectorize. **13 workers deployed, 408/408 tests passing.**

## Architecture

```
LMS (Azure Staging) ──REST API──→ AI Workers ──→ Vectorize / Workers AI
                                          │
Learner ──→ Tutor / Paths / Recs / Insights / Assistant ──→ AI03 Gateway ──→ LLM
Admin  ──→ Bottlenecks / Engagement / Narratives / Question Gen / Quality
```

## Workers

| Worker | Purpose | Endpoint | Tests |
|--------|---------|----------|-------|
| **ai-gateway** | LLM router — model selection, token budgeting, D1 tracking | Internal (service binding) | 14/14 ✅ |
| **ai-indexing** | Stream VTT → chunk → embed → Vectorize | `ai-indexing.yomi-alarape.workers.dev` | 22/22 ✅ |
| **ai-tutor** | Grounded Q&A + Voice (STT/TTS) + WebSocket | `ai-tutor.yomi-alarape.workers.dev` | 33/33 ✅ |
| **ai-paths** | Personalized learning paths | `ai-paths.yomi-alarape.workers.dev` | 20/20 ✅ |
| **ai-insights** | Post-quiz coaching + mentor session prep | `ai-insights.yomi-alarape.workers.dev` | 62/62 ✅ |
| **ai-recommendations** | Enhanced recs + fallback engine, 24h KV cache | `ai-recommendations.yomi-alarape.workers.dev` | 23/23 ✅ |
| **ai-assistant** | Platform-wide chat — course discovery, topic Q&A | `ai-assistant.yomi-alarape.workers.dev` | 37/37 ✅ |
| **ai-mentor** | Skill-gap analysis | `ai-mentor.yomi-alarape.workers.dev` | 29/29 ✅ |
| **ai-bottlenecks** | Admin bottleneck detection — aggregate analytics | `ai-bottlenecks.yomi-alarape.workers.dev` | 37/37 ✅ |
| **ai-engagement** | Admin engagement monitoring — video drop-off, stalls | `ai-engagement.yomi-alarape.workers.dev` | 37/37 ✅ |
| **ai-analytics** | Admin analytics narratives — NL summaries, comparisons | `ai-analytics.yomi-alarape.workers.dev` | 30/30 ✅ |
| **ai-question-gen** | Auto-generate quiz questions from lesson content | `ai-question-gen.yomi-alarape.workers.dev` | 23/23 ✅ |
| **ai-quality** | Validate generated questions — accuracy, bias, clarity | `ai-quality.yomi-alarape.workers.dev` | 20/20 ✅ |
| **ai-dashboard** | Static Pages site — worker status cards | Pages deploy | Built ⏳ |

## Phase Status

### Phase 1 — Complete ✅
7 workers: AI01 Indexing, AI03 Gateway, AI04 Tutor, AI06 Paths, AI07 Recommendations, AI08 Insights, AI13 Dashboard

### Phase 2 — Complete ✅
6 workers: F03a Skill-Gap, F03b Session Prep, F04a Bottlenecks, F04b Engagement, F05 Analytics Narratives, F06 Assistant, F07 Question Gen, F08 Quality Checks

### Phase 3 — Deferred
| Issue | Title | Reason |
|-------|-------|--------|
| F02 | Mentor Matching | Blocked on Mentor Directory data product |
| F09 | Assessment Approval Workflow | Split — AI (API) + LMS (UI) |

## Tech Stack

| Component | Choice |
|-----------|--------|
| **Runtime** | Cloudflare Workers (TypeScript 5.5+, ES2022) |
| **LLM** | Workers AI (`@cf/meta/llama-3.2-3b-instruct`, `llama-3.3-70b-instruct-fp8-fast`) |
| **Embeddings** | Workers AI (`@cf/baai/bge-large-en-v1.5`, 1024-dim) |
| **Vector DB** | Cloudflare Vectorize (`lms-lessons`, cosine) |
| **Cache** | Cloudflare KV (`LMS_CACHE`, 24h TTL) |
| **Relational** | Cloudflare D1 (`lms-platform`, org budgets) |
| **Session State** | Durable Objects + SQLite (tutor, assistant) |
| **File Storage** | Cloudflare R2 (`lms-content-staging`) |
| **Video** | Cloudflare Stream (VTT captions) |
| **Async Jobs** | Cloudflare Queues (`indexing-jobs`) |
| **Static Hosting** | Cloudflare Pages (dashboard) |
| **Observability** | Structured JSON spans via console.log |
| **Testing** | Vitest + `@cloudflare/vitest-pool-workers` |

## LLM Tier

| Tier | Model | Workers |
|------|-------|---------|
| Standard | `@cf/meta/llama-3.2-3b-instruct` | ai-tutor, ai-paths, ai-recommendations, ai-insights, ai-assistant, ai-mentor, ai-bottlenecks, ai-engagement, ai-quality |
| Quality | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | ai-analytics (narratives), ai-question-gen |
| Embeddings | `@cf/baai/bge-large-en-v1.5` | ai-indexing, ai-tutor, ai-recommendations, ai-assistant, ai-question-gen |

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
│   ├── ai-assistant/        # F06 — Platform Assistant ✅
│   ├── ai-mentor/           # F03a — Skill-Gap Analysis ✅
│   ├── ai-bottlenecks/      # F04a — Bottleneck Detection ✅
│   ├── ai-engagement/       # F04b — Engagement Monitoring ✅
│   ├── ai-analytics/        # F05 — Admin Narratives ✅
│   ├── ai-question-gen/     # F07 — Question Generation ✅
│   ├── ai-quality/          # F08 — Quality Checks ✅
│   └── ai-dashboard/        # AI13 — Demo Dashboard ⏳
├── Issues/
│   ├── ai/done/             # 17 completed slices
│   ├── ai/                  # Avatar lip-sync (future)
│   ├── future/              # F02, F09 (deferred)
│   ├── status.json          # Build progress tracker
│   └── README.md            # Slice map + build order
├── docs/
│   ├── lms-integration-guide.md       # LMS API integration details
│   ├── ai-features-overview.md        # Feature descriptions
│   ├── tech-stack.md                  # Infrastructure, bindings, URLs
│   ├── prd-ai-features-phase-1.md     # Original PRD (delivered)
│   ├── ai-mvp-scope.md                # MVP scope decisions
│   ├── ai-testing-guide.md            # Testing patterns
│   ├── brief-talking-avatar-tutor.md  # Avatar concept
│   └── voice-tutor-kpis.md            # Voice tutor metrics
├── architecture/
│   └── module-architecture.md         # Authoritative architecture doc
├── knowledge.md          # Session knowledge base
├── lmsapi.json           # LMS REST API contract (OpenAPI, 4.2MB)
├── progress.txt          # Current project state
└── AGENTS.md             # Agent instructions
```

## API Endpoints

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
| ai-insights | `/mentor/session-prep` | POST |
| ai-indexing | `/index`, `/deindex` | POST (webhook auth) |
| ai-assistant | `/assistant/ask` | POST |
| ai-assistant | `/assistant/clear` | POST |
| ai-mentor | `/mentor/skill-gap` | GET |
| ai-bottlenecks | `/admin/bottlenecks` | GET |
| ai-engagement | `/admin/engagement` | GET |
| ai-analytics | `/admin/narrative` | GET |
| ai-question-gen | `/questions/generate` | POST |
| ai-quality | `/questions/validate` | POST |

**Internal service bindings:**

| Binding | Used By |
|---------|---------|
| `AI_GATEWAY` → ai-gateway | All 12 frontend workers |
| `VECTORIZE_INDEX` → `lms-lessons` | ai-indexing, ai-tutor, ai-recommendations, ai-assistant, ai-question-gen |
| `TUTOR_SESSION` → TutorSession DO | ai-tutor |
| `ASSISTANT_SESSION` → AssistantSession DO | ai-assistant |
| `LMS_CACHE` → KV | ai-recommendations, ai-assistant |
| `INDEXING_QUEUE` → `indexing-jobs` | ai-indexing |
| `STREAM`, `LMS_CONTENT` | ai-indexing |

## Setup

```bash
# Install deps (per worker)
cd workers/<name> && npm install

# Set secrets (per worker, once)
npx wrangler secret put LMS_GATEWAY_URL      # all workers except ai-gateway, ai-dashboard
npx wrangler secret put LMS_INTERNAL_KEY     # all workers except ai-gateway, ai-dashboard
npx wrangler secret put LMS_WEBHOOK_SECRET   # ai-indexing only
npx wrangler secret put CLOUDFLARE_STREAM_API_TOKEN  # ai-indexing only
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID        # ai-indexing only

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
| `lms-content-staging` | R2 bucket | Video/PDF/PPTX storage | ✅ |
| `TutorSession` | Durable Object | Per-learner tutor conversation state | ✅ |
| `AssistantSession` | Durable Object | Per-learner assistant conversation state | ✅ |
