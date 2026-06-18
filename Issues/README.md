# Issues — AI Features for LMS

AI layer on top of the existing LMS platform. 8 vertical slices across 5 weeks.

## Architecture

```
LMS (ALREADY BUILT)              AI Workers (Cloudflare)           LLM
─────────────────────            ─────────────────────────         ───
REST API on localhost:8000       Cloudflare Workers (Edge)         Huawei ModelArts
                                                                   
/v1/lessons/{id}    ←── AI01 — Content Indexing                   
/v1/catalog         ←── AI02 — RAG Retrieval                      
/v1/learner/profile ←── AI03 — LLM Gateway ──────────────────→ Qwen3.6-flash
/v1/progress/user   ←── AI04 — Tutor                              Qwen3.6-27b
/v1/assessments/{id}←── AI06 — Learning Paths                     
                         AI07 — Enhanced Recommendations          
                         AI08 — Post-Quiz Insights                
                         AI13 — Demo Dashboard                    
```

**All AI Workers read from LMS via `GET /api/v1/...` with `LMS_INTERNAL_KEY`.**
**AI03 is the only Worker that calls Huawei. All others call AI03 via Service Binding.**

## Structure

```
Issues/
├── README.md                    ← This file
├── TECH_PRINCIPLES.md           ← (legacy — replaced by docs/ai-mvp-scope.md)
├── status.json                  ← Build progress tracker
├── ai/                          ← 8 MVP slices
│   ├── AI01-content-indexing.md
│   ├── AI02-rag-retrieval.md
│   ├── AI03-llm-gateway.md
│   ├── AI04-tutor.md
│   ├── AI06-learning-paths.md
│   ├── AI07-recommendations.md
│   ├── AI08-post-quiz-insights.md
│   └── AI13-demo-dashboard.md
├── ai/archive/                  ← Superseded slices (FastAPI + Ollama version)
└── platform/                    ← Legacy platform slices (LMS now built separately)
```

## Slice Map

| # | Week | Slice | Lines | Depends On |
|---|------|-------|-------|------------|
| 1 | 1 | AI03 LLM Gateway | ~300 | Huawei API key, LMS internal key |
| 2 | 2 | AI01 Indexing | ~350 | AI03, LMS lessons API |
| 3 | 2 | AI02 RAG Retrieval | ~150 | AI01 (Vectorize must have data) |
| 4 | 3 | AI04 Tutor | ~300 | AI02, AI03, LMS lessons API |
| 5 | 3 | AI08 Post-Quiz Insights | ~200 | AI03, LMS assessments API |
| 6 | 4 | AI06 Learning Paths | ~300 | AI03, LMS catalogue + profile + progress |
| 7 | 5 | AI07 Enhanced Recs | ~200 | AI03, LMS recs + catalogue + profile |
| 8 | 1-5 | AI13 Demo Dashboard | ~200 | All slices (cumulative) |

## How to Use

1. **Read** `docs/ai-mvp-scope.md` — what we're building and why
2. **Read** `docs/ai-lms-api-mapping.md` — what LMS endpoints each Worker calls
3. **Read** `docs/ai-cloudflare-huawei-architecture.md` — Cloudflare + Huawei architecture
4. **Start** with AI03 (Week 1). Nothing else works without the LLM Gateway.
5. **Work in week order.** Slices in the same week can be parallelized.
6. **Each PR is one slice.** 200-400 lines including tests.
7. **Each PR adds its dashboard card** to AI13.
8. **Update** `Issues/status.json` in your PR — set slice to `"complete"`.
9. **Test against real LMS** — `cloudflared tunnel` exposes LMS to Workers.

## Quick Start

```bash
# Terminal 1: Start LMS
docker compose up

# Terminal 2: Expose LMS to Cloudflare Workers
cloudflared tunnel --url http://localhost:8000

# Terminal 3: Develop AI03 (first slice)
cd workers/ai-gateway
npx wrangler secret put LMS_INTERNAL_KEY
npx wrangler secret put HUAWEI_API_KEY
LMS_GATEWAY_URL=https://xxx.trycloudflare.com wrangler dev

# Test
curl -X POST http://localhost:8787/generate \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"tier":"standard","org_id":"org-1"}'
```

## What Was Cut

See `docs/ai-mvp-scope.md` for rationale:
- ❌ AI05 Learner Profile — LMS already has richer profiles
- ❌ AI10a Question Generation — post-MVP
- ❌ AI10b Approval Workflow — post-MVP
- ❌ AI11 Quality Checks — post-MVP
- ❌ AI04b Tutor History — post-MVP (stateless first)
- ❌ AI09 Platform Assistant — post-MVP
- ❌ AI12 Fail Gracefully — implicit in each Worker

## Key Docs

| Doc | Purpose |
|-----|---------|
| `docs/ai-mvp-scope.md` | What we're building, why, what we cut |
| `docs/ai-lms-api-mapping.md` | Which LMS endpoints each Worker calls |
| `docs/ai-lms-integration-plan.md` | How AI Workers integrate with LMS |
| `docs/ai-data-requirements-cloudflare.md` | What data the AI layer stores |
| `docs/ai-cloudflare-huawei-architecture.md` | Cloudflare + Huawei infra architecture |
| `docs/ai-testing-guide.md` | **How to test each Worker during development** |
| `docs/ai-observability-eval-plan.md` | KPIs, evals, tracing, alert thresholds |
| `docs/vertical-slices-phase-1.md` | Detailed slice specifications |
| `api.json` | LMS API contract (authoritative reference) |
