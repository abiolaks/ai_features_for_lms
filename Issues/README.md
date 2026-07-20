# Issues — AI Features for LMS

AI layer on top of the existing LMS platform. **6/7 Workers complete** + Demo Dashboard. All deployed to Cloudflare Workers.

> **Architecture:** Cloudflare Workers + Vectorize + Workers AI
> **Status:** 6 complete, 1 pending (AI13 Dashboard deployment).

## Architecture

```
LMS (Azure Staging)               AI Workers (Cloudflare Edge)         LLM
──────────────────────            ─────────────────────────────       ───────────
REST API                          Cloudflare Workers (TypeScript)      Workers AI

POST /index  ──────────→  AI01 Indexing ──→ Stream (VTT) ──→ Vectorize
                              Worker fetches VTT, chunks, embeds, upserts

/v1/lessons/{id}    ←──────  AI04 Tutor ──→ Vectorize ──→ AI03 Gateway ──→ Workers AI
                              Per-learner Durable Objects (SQLite sessions)

/v1/catalog         ←──────  AI06 Paths ──→ AI03 Gateway ──→ Workers AI
/v1/learner/profile            Curriculum design prompt with prereq ordering
/v1/progress/user

/v1/catalog         ←──────  AI07 Recs ───→ KV + Vectorize + AI03 ──→ Workers AI
/v1/learner/profile            Enhance LMS recs OR generate from catalogue
/v1/courses/recs

/v1/assessments/*   ←──────  AI08 Insights ─→ AI03 Gateway ──→ Workers AI
/v1/progress/user              Quiz analysis + personalized review links

All features ─────────────→  AI13 Dashboard (Cloudflare Pages)
                              Single-page 6-card demo
```

**AI03 Gateway is the only Worker that calls Workers AI. All others call AI03 via Service Binding.**
**Vectorize (lms-lessons, 1024-dim, cosine) handles all retrieval — org-isolated via metadata filtering.**
**All AI Workers read from LMS via `GET /api/v1/...` with `LMS_INTERNAL_KEY`.**

## Structure

```
Issues/
├── README.md                    ← This file
├── ARCHITECTURE.md              ← Architecture decisions (see architecture/module-architecture.md)
├── TECH_PRINCIPLES.md           ← Code conventions, PR rules
├── status.json                  ← Build progress tracker (6/7 complete)
├── prd-ai-features-phase-1.md   ← PRD (delivered)
├── ai/                          ← Active slice issues
│   ├── AI13-demo-dashboard.md   ← Last remaining slice
│   └── done/                    ← Completed slices
│       ├── AI01-content-indexing.md
│       ├── AI03-llm-gateway.md
│       ├── AI04-tutor.md
│       ├── AI06-learning-paths.md
│       ├── AI07-recommendations.md
│       ├── AI07b-recommendations-fallback-engine.md
│       └── AI08-post-quiz-insights.md
└── future/                      ← Phase 2/3 features (F01-F05)
```

## Slice Status

| # | Slice | Worker | Lines | Tests | Status |
|---|-------|--------|------:|------:|--------|
| 1 | AI03 LLM Gateway | `ai-gateway` | 267 | 14/14 | ✅ Deployed |
| 2 | AI01 Content Indexing | `ai-indexing` | 830 | 16/16 | ✅ Deployed |
| 3 | AI04 Tutor | `ai-tutor` | 177 | 15/15 | ✅ Deployed |
| 4 | AI08 Post-Quiz Insights | `ai-insights` | ~550 | 30/30 | ✅ Deployed |
| 5 | AI06 Learning Paths | `ai-paths` | 536 | 20/20 | ✅ Deployed |
| 6 | AI07 Recommendations | `ai-recommendations` | ~480 | 23/23 | ✅ Deployed |
| * | AI07b Fallback Engine | (baked into AI07) | ~200 | — | ✅ Built |
| 7 | AI13 Demo Dashboard | `ai-dashboard` (Pages) | ~350 | — | ⏳ Built, pending deploy |

## What Changed From Original Plan

| Before | After | Why |
|--------|-------|-----|
| **AI02 RAG Retrieval** — separate Worker | **Deleted** — merged into AI04 | Vectorize handles retrieval natively |
| **AI05 Learner Profile** — separate Worker | **Deleted** — LMS already has richer profiles | Avoid duplication |
| **Local Ollama + LanceDB** | **Cloudflare Workers + Vectorize + Workers AI** | Zero infra, global edge, integrated |
| **bge-m3 embeddings** | **bge-large-en-v1.5 (1024-dim)** | Workers AI native |
| **Azure / Phoenix / OpenTelemetry** | **Workers Logs + structured JSON spans** | Built-in, zero config |

## How to Use

1. **Read** `docs/tech-stack.md` — current infrastructure, bindings, URLs
2. **Read** `docs/lms-api-contract-for-backend.md` — **THE** authoritative API contract
3. **Check** `Issues/status.json` — build progress
4. **Each PR is one slice.** 200-500 lines including tests.
5. **Test against staging LMS** — `lms-staging-api-*.azurewebsites.net`
6. **Deploy:** `cd workers/<name> && npx wrangler deploy`

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/tech-stack.md` | **Current infrastructure** — all bindings, URLs, diagrams |
| `docs/lms-api-contract-for-backend.md` | **THE authoritative API contract** (1259 lines) |
| `docs/lms-webhook-integration.md` | Webhook integration guide for LMS team |
| `docs/prd-ai-features-phase-1.md` | Original PRD (delivered) |
| `docs/ai-mvp-scope.md` | MVP scope decisions, what was cut |
| `docs/ai-testing-guide.md` | Testing patterns |
| `docs/ai-workers-deployment.md` | Deployment log |
