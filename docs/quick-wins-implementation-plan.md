# Quick Wins & Implementation Plan — Phase 1 MVP

## Assumptions

| # | Assumption |
|---|---|
| A1 | Azure is the cloud platform — all services provisioned in a single subscription |
| A2 | Azure OpenAI (AOAI) is the primary LLM provider — GPT-4o-mini (standard tier), GPT-4o (quality tier) |
| A3 | Azure AI Search handles chunking, embedding, and vector retrieval |
| A4 | Open-source models (Llama, Mistral, etc.) can be added later via Azure AI Foundry model catalog — the LLM Gateway abstraction supports model routing by tier, making this a config change, not a code change |
| A5 | Infrastructure provisioned via Bicep; CI/CD via GitHub Actions to Azure Container Apps |
| A6 | Managed Identity for all service-to-service auth — zero keys in code |
| A7 | Platform team delivers: Blob Storage content drop, skill taxonomy, data products (catalogue, learner context), quiz result data, UI surfaces |
| A8 | AI Engineer owns all AI logic between platform data inputs and AI responses |

---

## Quick Wins — Ordered by Speed to Value

A quick win is a slice that is (a) independently demoable, (b) has minimal internal dependencies, and (c) delivers visible AI value fast.

---

### Quick Win 1: LLM Gateway + Usage Budgeting (Slice 3)

**What it is:** Single entry point for all LLM calls. Model routing (fast vs capable), per-org token tracking, budget enforcement.

**Why it's a quick win:** Zero internal dependencies. Standalone Python service. ~300 lines of code. Establishes the foundation every other feature calls.

**How to achieve:**
- Wrap Azure OpenAI SDK behind a simple `generate(prompt, tier, org_id)` interface
- PostgreSQL table for org budget state (tokens consumed, monthly cap, billing period)
- Token counting from AOAI response metadata
- Soft throttle at 80% (warn), hard stop at 100% (reject)

**Requirements:**
- AOAI resource provisioned in Azure (gpt-4o-mini + gpt-4o deployed)
- PostgreSQL Flexible Server provisioned
- Container App environment provisioned
- Bicep templates for the above

**Timeline:** 1 week

**Demo:** `POST /generate` → response from gpt-4o-mini. Hit cap → rejected with admin message.

---

### Quick Win 2: Content Indexing Pipeline (Slice 1)

**What it is:** Reads raw content from Blob Storage, indexes into AI Search with embeddings and metadata.

**Why it's a quick win:** No internal dependencies. AI Search skillset handles chunking + embedding — mostly configuration. Self-sufficient testing via `POST /index`.

**How to achieve:**
- Configure AI Search index schema (fields: content, embedding, org_id, course_id, lesson_id, section, timestamp)
- Configure AI Search skillset (text split → AOAI embedding → index)
- Python orchestrator: reads from Blob, triggers skillset, writes artifacts back to Blob
- De-index endpoint for 60-second deletion SLA

**Requirements:**
- Azure AI Search provisioned (semantic tier)
- AOAI text-embedding-3-small deployed
- Blob Storage container `ai-content/` with `raw/`, `indexing/` folders
- Platform team drops sample content files in `raw/`

**Timeline:** 1–2 weeks

**Demo:** Upload lesson text to Blob → `POST /index` → query AI Search → chunks returned with metadata.

---

### Quick Win 3: Learner Profile Service (Slice 5)

**What it is:** CRUD service for learner profiles — skills, goals, role, experience level.

**Why it's a quick win:** Simple CRUD. No AI dependency. No internal dependencies. Feeds Path Generation and Recommendations.

**How to achieve:**
- PostgreSQL table: `learner_profiles` (id, org_id, skills[], goals, role, experience_level, created_at, updated_at)
- REST endpoints: `POST /profiles`, `GET /profiles/{id}`, `PUT /profiles/{id}`
- Validation: skills must be in platform taxonomy, goals max 500 chars, experience_level enum

**Requirements:**
- PostgreSQL Flexible Server provisioned
- Skill taxonomy from platform (list of valid skill tags)

**Timeline:** 1 week

**Demo:** Create profile → read it back → update → verify validation.

---

### Quick Win 4: RAG Retrieval Engine (Slice 2)

**What it is:** Vector search with scope filtering, citation assembly, groundedness enforcement.

**Why it's a quick win:** Depends only on Slice 1. AI Search does the heavy lifting — this is a thin query wrapper.

**How to achieve:**
- Wrapper around AI Search query endpoint
- Inject org_id as mandatory filter on every query
- Scope filter: lesson → filter by lesson_id; module → filter by module_id; course → filter by course_id
- Citation assembly from AI Search field mappings
- Empty result → return empty (groundedness enforcement)

**Requirements:**
- Slice 1 complete (index populated with test data)
- AI Search index schema with filterable fields

**Timeline:** 1 week

**Demo:** `POST /retrieve` with query + scope → chunks with citations, filtered to correct scope.

---

### Quick Win 5: In-Lesson Tutor (Slice 4)

**What it is:** Grounded Q&A in lessons — ask a question, get an answer with citations from the source material. This is the signature AI experience.

**Why it's a quick win:** Depends on Slices 2+3. Both are thin. The Tutor itself is ~500 lines of orchestration. Highest-impact demo piece.

**How to achieve:**
- Accept question + lesson context → RAG retrieve → LLM Gateway generate → attach citations → return
- Conversation history: PostgreSQL table, 30-day rolling window, learner-deletable
- Scope expansion: "not found in lesson" → offer "search module?"
- 30-day purge background job

**Requirements:**
- Slice 2 (RAG) complete
- Slice 3 (LLM Gateway) complete
- Indexed content in AI Search
- PostgreSQL conversation history table

**Timeline:** 1–2 weeks

**Demo:** Ask "What is X?" about indexed lesson → answer with citations. Ask about unindexed topic → "not found" + scope expansion offer.

---

## Master Use Case Table

| # | Use Case | Slice | Internal Deps | External Deps | Effort (weeks) | Cumulative Week | Quick Win |
|---|---|---|---|---|---|---|---|
| 1 | LLM Gateway + Budgeting | 3 | None | AOAI, PostgreSQL | 1 | 1 | ✅ QW1 |
| 2 | Content Indexing Pipeline | 1 | None | AI Search, AOAI embeddings, Blob Storage, sample content | 1–2 | 2–3 | ✅ QW2 |
| 3 | Learner Profile Service | 5 | None | PostgreSQL, skill taxonomy | 1 | 2–3 | ✅ QW3 |
| 4 | RAG Retrieval Engine | 2 | #1 | AI Search (indexed) | 1 | 3–4 | ✅ QW4 |
| 5 | In-Lesson Tutor | 4 | #2, #3 | PostgreSQL, chat UI | 1–2 | 4–6 | ✅ QW5 |
| 6 | Post-Activity Insights | 8 | #3 | Quiz results, review links | 1 | 5–7 | — |
| 7 | Personalized Learning Paths | 6 | #3, #5 | Catalogue Snapshot, path UI | 1–2 | 5–8 | — |
| 8 | Course Recommendations | 7 | #3, #5 | Catalogue Snapshot, Learner Context, Redis | 1–2 | 6–9 | — |
| 9 | Assessment Generation | 10 | #2, #3 | Lesson content, course difficulty, admin UI | 2 | 6–8 | — |
| 10 | Platform Assistant | 9 | #3, #5 | Progress data, assistant UI | 1 | 6–9 | — |
| 11 | Quality Checks | 11 | #10 | Course difficulty, publish gate UI | 1 | 7–9 | — |
| 12 | Fail Gracefully Wiring | 12 | #5, #7, #8, #6, #10, #11 | All UI surfaces | 1 | 8–10 | — |

**Total estimated effort: 8–10 weeks** (with parallel tracks on Slices 1+3+5, then 6+7+8+10 after dependencies unlock)

---

## Timeline (Parallel Execution)

```
Week 1    Week 2    Week 3    Week 4    Week 5    Week 6    Week 7    Week 8
─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────
Slice 3  ████████│         │         │         │         │         │         │  QW1
(Gateway)        │         │         │         │         │         │         │
                 │         │         │         │         │         │         │
Slice 1  ████████████████│         │         │         │         │         │  QW2
(Indexing)               │         │         │         │         │         │
                         │         │         │         │         │         │
Slice 5  ████████│         │         │         │         │         │         │  QW3
(Profile)          │         │         │         │         │         │         │
                         │         │         │         │         │         │
Slice 2           │████████│         │         │         │         │         │  QW4
(RAG)                        │         │         │         │         │         │
                             │         │         │         │         │         │
Slice 4           │         │████████████████│         │         │         │  QW5
(Tutor)           │         │                 │         │         │         │
                                         │         │         │         │         │
Slice 8           │         │         │████████│         │         │         │
(Insights)        │         │         │         │         │         │         │
                             │         │         │         │         │         │
Slice 6           │         │         │████████████████│         │         │
(Paths)           │         │         │                 │         │         │
                             │         │         │         │         │         │
Slice 10          │         │         │████████████████│         │         │
(Assessment)      │         │         │                 │         │         │
                                         │         │         │         │         │
Slice 7           │         │         │         │████████████████│         │
(Recs)            │         │         │         │                 │         │
                                         │         │         │         │         │
Slice 9           │         │         │         │         │████████████████│
(Assistant)       │         │         │         │         │                 │
                                                             │         │
Slice 11          │         │         │         │         │         │████████│
(Quality)         │         │         │         │         │         │         │
                                                             │         │
Slice 12          │         │         │         │         │         │         │██│
(Fail Gracefully) │         │         │         │         │         │         │  │
                  │         │         │         │         │         │         │  │
──────────────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴──
                  QW1       QW2+3     RAG       Tutor     Paths     Recs     Done
                                            Insights  AsmtGen  Asstnt  Quality
```

---

## Next Steps (Beyond Quick Wins)

| # | Slice | Action Required |
|---|---|---|
| 6 | Post-Activity Insights | Platform delivers quiz result data contract. Simple LLM call with score → tone logic. |
| 7 | Personalized Learning Paths | Platform delivers Catalogue Snapshot data product. Profile + LLM → path. |
| 8 | Course Recommendations | Platform delivers Catalogue Snapshot + Learner Context. AI + fallback cascade + Redis cache. |
| 9 | Assessment Generation | Platform delivers admin review UI. RAG + quality LLM → questions with source traces. |
| 10 | Platform Assistant | Platform delivers progress/enrollment data + assistant widget UI. Intent routing + Tutor handoff. |
| 11 | Quality Checks | Built on Assessment Gen. Dupe detection + reading level comparison. |
| 12 | Fail Gracefully Wiring | Touches all features. Degradation signals + status indicator. |

---

## Blockers & Risks

| # | Blocker | Severity | Mitigation |
|---|---|---|---|
| B1 | **AOAI capacity in region** — models may not be available in chosen region due to capacity limits | High | Provision AOAI early (Week 0). Have a backup region. Consider provisioned throughput for pilot. |
| B2 | **AI Search tier limits** — free/basic tiers lack semantic search and vector support | High | Use Standard S1 tier minimum for vector + semantic. Verify quota before Week 1. |
| B3 | **Platform team delays** — Blob Storage, data products, UI surfaces not ready when needed | High | Self-sufficient testing pattern: `POST /index` triggers indexing without platform. Mock data products for feature development. |
| B4 | **Skill taxonomy doesn't exist** — Learner Profile Service can't validate skills | Medium | Build a static taxonomy file as fallback. Platform team can replace later. |
| B5 | **Content not available for indexing** — no lesson text/transcripts to index | Medium | Generate synthetic lesson content for development. Real content required for pilot only. |
| B6 | **Open-source model integration scope creep** — stakeholders want Llama/Mistral before Phase 2 | Low | LLM Gateway already supports model routing. Adding a model is a config change. Gate it: Phase 1 = AOAI only, Phase 2 = open-source models via Foundry. |
| B7 | **Latency on Tutor** — RAG + LLM round-trip may exceed acceptable response time | Medium | Monitor via App Insights from Day 1. Target <5s p95. If exceeded, investigate AI Search semantic ranking config or model tier. |
| B8 | **Budget enforcement complexity** — monthly resets, per-org caps, billing periods | Low | Start with simple UTC-month resets. Org admins configure cap as integer. Iterate in Phase 2. |

---

## Open-Source Model Path

The LLM Gateway supports model routing by tier. To add open-source models:

1. Deploy model in Azure AI Foundry model catalog (e.g., Llama 3, Mistral)
2. Add model deployment to LLM Gateway config: `{"tier": "standard", "provider": "foundry", "model": "llama-3-8b", "endpoint": "..."}`
3. No code change — Gateway routes `tier=standard` to the configured model

This can be done in Phase 2 without architectural changes. No Phase 1 work required beyond designing the Gateway to be provider-agnostic from day one.

---

## Summary

| Metric | Value |
|---|---|
| Quick wins | 5 (QW1–QW5) |
| Quick win delivery | Weeks 1–6 |
| Total slices | 12 |
| Total estimated effort | 8–10 weeks |
| Parallel tracks | 3 (Slices 1, 3, 5 start simultaneously) |
| Most critical path | Slices 1 → 2 → 4 (Indexing → RAG → Tutor) |
| First demo possible | Week 4 (LLM Gateway + Indexing + RAG + Tutor = grounded Q&A) |
| Blockers to resolve Week 0 | AOAI provisioning, AI Search provisioning, Blob Storage setup |
