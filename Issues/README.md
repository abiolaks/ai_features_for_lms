# Issues — AI Features for LMS

AI layer on top of the existing LMS platform. 7 Workers across 5 weeks.

> **Architecture:** Cloudflare AI Search (managed RAG) + AI03 LLM Gateway (Workers AI)
> **Key decision:** Using AI Search for retrieval (not Vectorize). AI Search handles chunking, embedding, hybrid search, and reranking automatically. AI03 remains the single LLM gateway. All LLM calls go through Workers AI (`@cf/meta/llama-3.2-3b-instruct` for standard, `@cf/mistral/mistral-7b-instruct-v0.2` for quality). See `docs/ai-search-decision.md` for rationale.

## Architecture

```
LMS (ALREADY BUILT, LIVE)         AI Workers (Cloudflare)               LLM
──────────────────────────        ─────────────────────────             ───
REST API (hosted)                 Cloudflare Workers (Edge)              LLM
──────────────────────────        ─────────────────────────             ───────────
POST /webhook  ──────────→  AI01 — Content Indexing → Cloudflare Stream (captions)
                             then uploads transcript → AI Search
                                   
/v1/lessons/{id}    ←──────  AI04 — Tutor ────────────→ AI Search (hybrid search)
                             then pipes chunks to ────→ AI03 Gateway ────→ Workers AI

/v1/catalog         ←──────  AI06 — Learning Paths ───→ AI03 Gateway ────→ Workers AI
/v1/learner/profile                                                         
/v1/progress/user                                                          

/v1/courses/recs    ←──────  AI07 — Enhanced Recs ────→ AI03 Gateway ────→ Workers AI
/v1/assessments/{id}←──────  AI08 — Quiz Insights ────→ AI03 Gateway ────→ Workers AI

All features ─────────────→  AI13 — Demo Dashboard
```

**All AI Workers read from LMS via `GET /api/v1/...` with `LMS_INTERNAL_KEY`.**
**AI03 is the only Worker that calls Workers AI. All others call AI03 via Service Binding.**
**AI Search handles all retrieval. No separate retrieval Worker. No Vectorize.**

## Structure

```
Issues/
├── README.md                    ← This file
├── status.json                  ← Build progress tracker
├── ai/                          ← 7 MVP slices + 1 contingency
│   ├── AI01-content-indexing.md
│   ├── AI03-llm-gateway.md
│   ├── AI04-tutor.md
│   ├── AI06-learning-paths.md
│   ├── AI07-recommendations.md
│   ├── AI07b-recommendations-fallback-engine.md  ← Contingency
│   ├── AI08-post-quiz-insights.md
│   └── AI13-demo-dashboard.md
├── ai/archive/                  ← Superseded slices (FastAPI + Ollama version, deleted AI02)
├── platform/                    ← Legacy — LMS already built and live
└── future/                      ← External briefs, future features
```

## Slice Map

| # | Week | Slice | Lines | Depends On |
|---|------|-------|-------|------------|
| 1 | 1 | AI03 LLM Gateway | ~250 | LMS internal key |
| 2 | 2 | AI01 Content Indexing | ~200 | AI03, AI Search instances, Cloudflare Stream API |
| 3 | 3 | AI04 Tutor | ~200 | AI01 (lessons must be indexed), AI03 |
| 4 | 3 | AI08 Post-Quiz Insights | ~200 | AI03, LMS assessments API |
| 5 | 4 | AI06 Learning Paths | ~300 | AI03, LMS catalogue + profile + progress |
| 6 | 5 | AI07 Enhanced Recs | ~200 | AI03, LMS recs + catalogue + profile |
| * | * | AI07b Fallback Engine | ~350 | AI03, AI Search, D1, LMS catalog + profile + skill gaps (CONTINGENCY) |
| 7 | 1-5 | AI13 Demo Dashboard | ~200 | All slices (cumulative) |

## Build Order

```
Week 1: AI03 LLM Gateway          ← START HERE. Nothing else works without it.
Week 2: AI01 Content Indexing     ← Provision AI Search instances, wire webhook
Week 3: AI04 Tutor + AI08 Insights ← Parallel (Tutor needs AI01 lessons indexed)
Week 4: AI06 Learning Paths
Week 5: AI07 Enhanced Recs (+ AI07b if LMS recs insufficient)
Ongoing: AI13 Demo Dashboard      ← One card added per slice
```

## What Changed From Original Plan

| Before | After | Why |
|--------|-------|-----|
| **AI02 RAG Retrieval** — separate Worker | **Deleted** — merged into AI04 | AI Search handles retrieval natively. No separate retrieval Worker needed. |
| **Vectorize** — manual chunking, embedding, indexing | **AI Search** — managed RAG pipeline | 30% less code, hybrid search, reranking, built-in caching for free |
| **bge-m3 embeddings** — manual calls | **AI Search auto-embeds** | Cloudflare manages embedding model selection |
| **Metadata filtering** for org isolation | **Namespaces + instances** per org | Physical isolation at infra level, can't leak |
| ~800 lines for indexing+retrieval+tutor | ~350 lines for indexing+tutor | AI02 deleted, AI01 simplified, AI04 simplified |

## How to Use

1. **Read** `docs/ai-prerequisites-setup.md` — accounts, keys, resources needed
2. **Read** `docs/ai-mvp-scope.md` — what we're building and why
3. **Read** `docs/ai-lms-api-mapping.md` — what LMS endpoints each Worker calls
5. **Read** `docs/ai-cloudflare-architecture.md` — Cloudflare Workers AI architecture
6. **Start** with AI03 (Week 1). Nothing else works without the LLM Gateway.
7. **Each PR is one slice.** 150-300 lines including tests.
8. **Each PR adds its dashboard card** to AI13.
9. **Test against real LMS** — the LMS is live and hosted, no Docker needed.

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/ai-prerequisites-setup.md` | **☐ START HERE** — accounts, keys, resources needed before coding |
| `docs/ai-mvp-scope.md` | What we're building, why, what we cut |
| `docs/ai-lms-api-mapping.md` | Which LMS endpoints each Worker calls |
| `docs/ai-lms-integration-plan.md` | How AI Workers integrate with LMS |
| `docs/ai-data-requirements-cloudflare.md` | What data the AI layer stores |
| `docs/ai-cloudflare-architecture.md` | Cloudflare Workers AI architecture |
| `docs/ai-testing-guide.md` | **How to test each Worker during development** |
| `docs/ai-observability-eval-plan.md` | KPIs, evals, tracing, alert thresholds |
| `api.json` | LMS API contract (authoritative reference) |
