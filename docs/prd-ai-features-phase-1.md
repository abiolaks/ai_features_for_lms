# PRD: AI Features for LMS — Phase 1 MVP

**Status:** Complete — Phase 1 delivered (6/7 AI workers deployed, 1 Pages dashboard).  
**Date:** 2026-06-10  
**Architecture:** Cloudflare Workers + Workers AI  
**LMS Contract:** `lms-api-contract-for-backend.md` → staging LMS at `lms-staging-api-*.azurewebsites.net`

---

## Problem

The LMS platform stores courses, lessons, learner profiles, progress, and quiz results — but it cannot reason about that data. Learners can browse content but can't ask questions. They can see quiz scores but don't get coaching. They can view a catalogue but don't get personalized paths. The LMS is a storage system, not an intelligent system.

## Solution

An AI layer of 7 Cloudflare Workers that read from the LMS API and generate what the LMS cannot: cited answers, coaching insights, personalized learning paths, and recommendation explanations. All powered by Cloudflare Workers AI (Llama 3.2 / Mistral), all running on Cloudflare's edge.

## MVP Features (7 Workers)

| # | Feature | What It Does | User Value |
|---|---------|-------------|------------|
| 1 | **Tutor** | "Ask any question about this lesson, get a cited answer" | Don't re-read the lesson — ask directly |
| 2 | **Post-Quiz Insights** | "Here's what your score means and what to study next" | Turn quiz results into actionable coaching |
| 3 | **Learning Paths** | "Your AI-personalized curriculum, ordered with reasons" | Don't guess what to take next |
| 4 | **Enhanced Recommendations** | "We recommend this course — and here's exactly why it fits you" | Trust the recommendation with transparent reasoning |
| 5 | **LLM Gateway** | Unified entry point for all AI calls, budget enforcement | Centralized cost control, provider abstraction |
| 6 | **Content Indexing** | Chunk, embed, and index all lesson content for search | Foundation for RAG-powered features |
| 7 | **Demo Dashboard** | Live dashboard proving every feature works with real data | Visibility into what's built |

## Architecture

```
Learner Browser
  ├── LMS Gateway (Azure staging) — platform data
  └── AI Workers (*.workers.dev) — AI features
        │
        ├── AI Workers call LMS Gateway for data (X-API-Key: LMS_INTERNAL_KEY)
        │
        └── AI03 Gateway Worker → Workers AI (Llama 3.2 / Mistral)
              │
              └── No fallback needed — Workers AI runs on the same edge
```

**Key decisions:**
- LMS owns all data (courses, profiles, progress, quizzes). AI Workers **read only**.
- AI03 is the only Worker that calls Workers AI. All others call AI03 via Service Binding.
- Embeddings use Cloudflare Workers AI `bge-large-en-v1.5`. No local models.
- Vector storage is Cloudflare Vectorize. No LanceDB.
- AI data (budgets, caches, conversations) stored in D1/KV/DO.

## Success Criteria — MVP Is Done When

- [ ] **Tutor:** Index 3 real lessons → ask 5 content questions → get cited, grounded answers
- [ ] **Insights:** Submit a quiz → AI generates personalized coaching insight with review links
- [ ] **Paths:** Generate a learning path using real learner profile + real course catalogue
- [ ] **Recs:** Get course recommendations with AI-generated "why this fits" explanations
- [ ] **Gateway:** Workers AI calls work, budget enforced
- [ ] **Dashboard:** Live at deployed URL, all 7 cards work with real LMS data
- [ ] **All features degrade gracefully** when AI is unavailable

## What's Explicitly NOT in MVP

| Feature | Why Not MVP |
|---------|------------|
| Learner Profile Service | LMS already has richer profiles with gamification, streaks, stats |
| Question Generation | Complex prompt engineering, needs quality tier LLM, approval dependency |
| Approval Workflow | LMS admin dashboard already handles assessment management |
| Quality Checks | No learner-visible impact |
| Conversation History | Stateless Q&A is sufficient for MVP |
| Platform Assistant | Requires multi-turn conversation management |
| Dedicated Fail-Gracefully Worker | Each Worker handles its own error states |

## Build Plan — 5 Weeks, 8 PRs

| Week | Slice | Worker | Lines |
|------|-------|--------|-------|
| 1 | AI03 | LLM Gateway | ~300 |
| 2 | AI01 | Content Indexing | ~350 |
| 2 | AI01 | Content Indexing | ~830 |
| 3 | AI04 | Tutor | ~300 |
| 3 | AI08 | Post-Quiz Insights | ~200 |
| 4 | AI06 | Learning Paths | ~300 |
| 5 | AI07 | Enhanced Recs | ~200 |
| 1-5 | AI13 | Demo Dashboard | ~200 |

**Total:** ~2,000 lines of Worker code. 8 PRs. Each PR is reviewable in ≤20 minutes.

## Dependencies

| Dependency | Status | Owner |
|-----------|--------|-------|
| LMS REST API (api.json) | ✅ Built | LMS team |
| LMS Gateway reachable from CF | ✅ cloudflared tunnel setup | Dev |
| Vectorize index created | ⚠️ Needed before Week 2 | Infra |
| D1 database created | ⚠️ Needed before Week 1 | Infra |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Workers AI latency spikes | Slow tutor responses (>500ms) | Streaming responses in post-MVP, KV caching |
| LMS API changes break Workers | Broken AI features | Contract tests against api.json in CI |
| Budget exhaustion during demo | 429 errors visible | Set high default cap, monitor in dashboard |
| Vectorize cold start | Slow first retrieval | Pre-warm with seed queries after indexing |
| Cloudflare Tunnel flakiness | Can't dev against real LMS | Mock LMS responses for unit tests, tunnel for integration only |

## Reference Docs

| Doc | Purpose |
|-----|---------|
| `api.json` | LMS API contract (69K lines OpenAPI) |
| `docs/ai-mvp-scope.md` | Detailed MVP scope + what was cut |
| `docs/ai-lms-api-mapping.md` | Which LMS endpoints each Worker calls |
| `docs/ai-lms-integration-plan.md` | Integration architecture |
| `docs/ai-data-requirements-cloudflare.md` | What data AI layer stores |
| `docs/ai-cloudflare-architecture.md` | Cloudflare Workers AI infra |
| `docs/vertical-slices-phase-1.md` | Detailed slice specs |
| `Issues/ai/` | Individual issue files per slice |
| `Issues/status.json` | Build progress tracker |
