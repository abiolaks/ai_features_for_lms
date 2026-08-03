# Module Architecture — AI Workers (Cloudflare)

> Last updated: 2026-08-03. 13 workers deployed, 408/408 tests passing.

---

## Deployed Workers

| Worker | URL | Status | Key Technology |
|--------|-----|--------|---------------|
| `ai-gateway` | Internal (service binding) | ✅ Live | Workers AI (llama-3.2-3b / llama-3.3-70b), D1 budget tracking |
| `ai-indexing` | `ai-indexing.yomi-alarape.workers.dev` | ✅ Live | Queue consumer, Vectorize, Stream VTT, unpdf |
| `ai-tutor` | `ai-tutor.yomi-alarape.workers.dev` | ✅ Live | Durable Objects (SQLite), WebSocket streaming |
| `ai-paths` | `ai-paths.yomi-alarape.workers.dev` | ✅ Live | Service binding to ai-gateway |
| `ai-insights` | `ai-insights.yomi-alarape.workers.dev` | ✅ Live | 62/62 tests, quiz analysis + review links + session prep |
| `ai-recommendations` | `ai-recommendations.yomi-alarape.workers.dev` | ✅ Live | 23/23 tests, enhanced + fallback engine, KV cache |
| `ai-assistant` | `ai-assistant.yomi-alarape.workers.dev` | ✅ Live | 37/37 tests, DO (SQLite), RAG retrieval, course suggestions |
| `ai-mentor` | `ai-mentor.yomi-alarape.workers.dev` | ✅ Live | 29/29 tests, skill-gap analysis |
| `ai-bottlenecks` | `ai-bottlenecks.yomi-alarape.workers.dev` | ✅ Live | 37/37 tests, aggregate analytics, per-module bottleneck detection |
| `ai-engagement` | `ai-engagement.yomi-alarape.workers.dev` | ✅ Live | 37/37 tests, video drop-off, stall rates, activity patterns |
| `ai-analytics` | `ai-analytics.yomi-alarape.workers.dev` | ✅ Live | 30/30 tests, NL narratives, period comparisons, llama-3.3-70b |
| `ai-question-gen` | `ai-question-gen.yomi-alarape.workers.dev` | ✅ Live | 23/23 tests, quiz questions from lesson content, llama-3.3-70b |
| `ai-quality` | `ai-quality.yomi-alarape.workers.dev` | ✅ Live | 20/20 tests, validate accuracy/bias/clarity, llama-3.2-3b |
| `ai-dashboard` | `ai-dashboard.pages.dev` | ⏳ Built | Pages static site, 13 worker status cards |

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          LMS Backend (Python)                            │
│                                                                          │
│  On lesson publish/unpublish: POST /index, POST /deindex                 │
│  X-Webhook-Secret ───────────────────────────────────────────────────┐   │
│                                                                      │   │
│  Learner-facing: profile, catalog, progress, assessments             │   │
│  X-API-Key ──────────────────────────────────────────────────────────┤   │
│                                                                      │   │
│  Admin: progress/aggregate, assessments/aggregate, engagement        │   │
│  X-API-Key ──────────────────────────────────────────────────────────┤   │
└──────────────────────────────────────────────────────────────────────┼───┘
                                                                       │
┌──────────────────────────────────────────────────────────────────────▼───┐
│                        ai-indexing Worker                                │
│                                                                          │
│  POST /index  → queue  → chunkText() → embedAndUpsert() → Vectorize     │
│  POST /deindex→ direct → deleteVectors()                                 │
│  POST /extract-pdf → unpdf → queue                                       │
│                                                                          │
│  Bindings: AI (bge-large-en-v1.5), Vectorize (lms-lessons),              │
│            Stream, INDEXING_QUEUE, LMS_CONTENT (R2)                      │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Vectorize: lms-lessons                               │
│                     1024-dim cosine                                      │
│                                                                          │
│  Each vector: { id, values, metadata: { title, lesson_id, course_id,    │
│    org_id, content_type, chunk_index, total_chunks, content, ... } }     │
│                                                                          │
│  Content chunked at ~2000 chars (10KB metadata limit).                   │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
│   ai-tutor       │  │  ai-assistant    │  │  ai-recommendations      │
│                  │  │                  │  │                          │
│  POST /tutor/ask │  │  POST /assistant │  │  GET  /recommendations/  │
│  POST /tutor/clr │  │    /ask          │  │        dashboard         │
│  WS  /tutor/ws   │  │  POST /assistant │  │  GET  /recommendations/  │
│                  │  │    /clear        │  │        next              │
│  TutorSession DO │  │                  │  │                          │
│  (per learner)   │  │  AssistantSession│  │  Enhanced + Fallback     │
│  SQLite history  │  │  DO (per learner)│  │  KV cache (24h TTL)      │
│  + Vectorize RAG │  │  SQLite + RAG    │  │  Content similarity      │
│  + WebSocket     │  │  + Catalog-aware │  │                          │
└────────┬─────────┘  └────────┬─────────┘  └───────────┬──────────────┘
         │                     │                        │
         └─────────────────────┼────────────────────────┘
                               │
          ┌────────────────────┼────────────────────────────┐
          ▼                    ▼                            ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
│   ai-paths       │  │  ai-insights     │  │  ai-mentor               │
│                  │  │                  │  │                          │
│  POST /paths/    │  │  POST /insights/ │  │  GET /mentor/skill-gap   │
│    generate      │  │    generate      │  │                          │
│                  │  │  POST /mentor/   │  │  Profile → skills        │
│  Profile +       │  │    session-prep  │  │  Catalog → requirements  │
│  Catalog +       │  │                  │  │  Progress → gaps         │
│  Progress →      │  │  Quiz analysis   │  │  Gateway → analysis      │
│  Learning path   │  │  + Review links  │  │                          │
│                  │  │  + Session prep  │  │                          │
└────────┬─────────┘  └────────┬─────────┘  └───────────┬──────────────┘
         │                     │                        │
         └─────────────────────┼────────────────────────┘
                               │
          ┌────────────────────┼────────────────────────────┐
          ▼                    ▼                            ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
│  ai-bottlenecks  │  │  ai-engagement   │  │  ai-analytics            │
│                  │  │                  │  │                          │
│  GET /admin/     │  │  GET /admin/     │  │  GET /admin/narrative    │
│    bottlenecks   │  │    engagement    │  │                          │
│                  │  │                  │  │  Aggregate data →        │
│  progress/agg +  │  │  engagement +    │  │  llama-3.3-70b →         │
│  assessments/agg │  │  video drop-off  │  │  NL summaries +          │
│  → gateway →     │  │  + stall rates + │  │  period comparisons      │
│  module analysis │  │  activity →      │  │                          │
│                  │  │  gateway →       │  │                          │
│                  │  │  insights        │  │                          │
└────────┬─────────┘  └────────┬─────────┘  └───────────┬──────────────┘
         │                     │                        │
         └─────────────────────┼────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
          ┌──────────────────┐  ┌──────────────────┐
          │ ai-question-gen  │  │  ai-quality      │
          │                  │  │                  │
          │  POST /questions │  │  POST /questions │
          │    /generate     │  │    /validate     │
          │                  │  │                  │
          │  Lesson content  │  │  Accuracy check  │
          │  → llama-3.3-70b │  │  Bias detection  │
          │  → questions[]   │  │  Clarity review  │
          └────────┬─────────┘  └────────┬─────────┘
                   │                     │
                   └──────────┬──────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        ai-gateway Worker                                 │
│                                                                          │
│  POST /generate  → env.AI.run(model, {messages})  → JSON response       │
│  POST /stream    → env.AI.run(model, {stream:true}) → SSE stream        │
│                                                                          │
│  Budget tracking: D1 (org_budgets table)                                 │
│                                                                          │
│  Models:                                                                 │
│    standard: @cf/meta/llama-3.2-3b-instruct (1024 max tokens)           │
│    quality:  @cf/meta/llama-3.3-70b-instruct-fp8-fast (2048 max)        │
│                                                                          │
│  Bindings: AI, DB (D1), LMS_CACHE (KV)                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 2 Workers

### F03a: Skill-Gap Analysis (ai-mentor)

`GET /mentor/skill-gap?learner_id=&org_id=`

```
1. Fetch learner profile → preferences for skills/goals
2. Fetch catalogue → course prerequisites + estimated_hours
3. Fetch progress → exclude completed courses
4. Map learner skills against catalogue requirements
5. Call ai-gateway → structured gap analysis
6. Return { gaps, summary } with courses_available + estimated_hours
```

**Degraded:** Empty profile → suggests adding skills. Gateway down → keyword matching.

### F03b: Session Prep Insights (ai-insights)

`POST /insights/mentor/session-prep { learner_id, mentor_id, org_id }`

```
1. Fetch profile + progress + assessment summary from LMS
2. Identify: stalled modules (<30% progress), lowest quiz topics
3. Build prompt with progress + quiz data
4. Call ai-gateway → 3-topic agenda prioritized by urgency
5. Return { recent_activity, suggested_agenda, prep_materials }
```

### F06: Platform Assistant (ai-assistant)

`POST /assistant/ask`, `POST /assistant/clear`

```
AssistantSession DO (per learner):
  1. Load history from SQLite (MAX 20 msgs)
  2. Embed question → query Vectorize (all courses, no lesson filter)
  3. Fetch catalogue from LMS
  4. Build prompt: [History] + [Content] + [Catalogue]
  5. Call ai-gateway → answer + course suggestions
  6. Save exchange to SQLite
```

Differences from Tutor: course scope (not lesson), returns `suggested_courses`, one DO per learner across all courses, prompt injection defense.

### F04a: Bottleneck Detection (ai-bottlenecks)

`GET /admin/bottlenecks?org_id=&period=last_90_days`

```
1. Fetch progress/aggregate → per-module completion stats
2. Fetch assessments/aggregate → per-topic quiz scores
3. Identify: high median_completion_days vs expected, low pass rates
4. Call ai-gateway → bottleneck narrative + per-module severity
5. Return { bottlenecks[], summary, period }
```

Cohort suppression: <10 learners → empty results. <5 in any stat → null.

### F04b: Engagement Monitoring (ai-engagement)

`GET /admin/engagement?org_id=&period=last_30_days`

```
1. Fetch admin/engagement → video completion, drop-off, stall rates, activity
2. Identify: low-completion videos, stalled modules, off-peak patterns
3. Call ai-gateway → engagement insights + recommendations
4. Return { video_completion, drop_off_videos, course_stalls, activity_patterns, summary }
```

### F05: Admin Analytics Narratives (ai-analytics)

`GET /admin/narrative?org_id=&period=`

```
1. Fetch progress/aggregate + assessments/aggregate + engagement
2. Build data-rich prompt with all aggregate metrics
3. Call ai-gateway (quality tier → llama-3.3-70b)
4. Return structured narrative: { overall_summary, highlights[], concerns[], recommendations[], period_comparison }
```

Only worker using the quality-tier model for higher-quality NL generation.

### F07: Question Generation (ai-question-gen)

`POST /questions/generate { lesson_id, question_count, types[], difficulty, org_id }`

```
1. Fetch lesson content from LMS
2. Embed + query Vectorize for relevant content chunks
3. Build prompt: [Content] + [Question types] + [Difficulty]
4. Call ai-gateway (quality tier → llama-3.3-70b)
5. Return { questions[], metadata }
```

Question types: multiple_choice, true_false, short_answer.

### F08: Quality Checks (ai-quality)

`POST /questions/validate { questions[], org_id }`

```
1. For each question, validate:
   - Accuracy: correct answer matches content
   - Bias: no demographic/cultural assumptions
   - Clarity: unambiguous wording, grade-level appropriate
   - Distractors: plausible wrong answers
2. Call ai-gateway (standard tier) for validation
3. Return { results[], overall_score, issues[] }
```

---

## Key Architectural Decisions

### 1. Durable Objects for Conversation State

**Decision:** Each learner gets a dedicated Durable Object (DO) with SQLite storage for conversation history (ai-tutor, ai-assistant).

**Why:**
- Without DOs, every request is stateless — LLM has no memory of previous questions
- DOs provide single-threaded, strongly-consistent state per learner
- SQLite persists across evictions, crashes, and redeploys
- Deterministic routing (`idFromName`) ensures same learner always reaches their DO

**Trade-off:** Cold starts (~100ms) if DO was evicted. Mitigated by periodic requests.

### 2. WebSocket Streaming (ai-tutor)

**Decision:** `GET /tutor/ws` streams LLM tokens as generated. Same DO serves both HTTP and WS — conversation persists across connection types.

**Why:** HTTP: 3-8s spinner. WebSocket: words appear in ~500ms. Citations sent first.

### 3. Queue-Based Async Indexing

**Decision:** `POST /index` pushes to Cloudflare Queue (batch_size=3, retry 3x, timeout 60s). LMS gets 202 instantly.

**Why:** Synchronous indexing takes 5-120s — exceeds Workers 30s CPU limit. Queue absorbs bursts.

### 4. Direct Vectorize (No AI Search)

**Decision:** Use Workers AI embedding + direct Vectorize upsert. No Cloudflare AI Search.

**Why:** AI Search (beta) failed to persist vectors. Direct Vectorize is instant, mature, full metadata control. We chunk ourselves (2000 chars, sentence boundaries).

### 5. Service Bindings for Inter-Worker Communication

**Decision:** Workers communicate via Cloudflare service bindings, not public URLs.

**Why:** No public exposure of ai-gateway. Lower latency. No auth between trusted workers.

### 6. Two LLM Tiers

**Decision:** Standard tier (llama-3.2-3b) for real-time/low-latency. Quality tier (llama-3.3-70b) for narrative generation and question creation.

| Tier | Model | Max Tokens | Workers |
|------|-------|-----------|---------|
| Standard | llama-3.2-3b-instruct | 1024 | tutor, paths, recs, insights, assistant, mentor, bottlenecks, engagement, quality |
| Quality | llama-3.3-70b-instruct-fp8-fast | 2048 | analytics, question-gen |
| Embeddings | bge-large-en-v1.5 | — | indexing, tutor, recs, assistant, question-gen |

### 7. Degraded Mode Everywhere

**Decision:** Every worker returns HTTP 200 with `"degraded"` status on external failures. Never throw 5xx.

**Why:** LMS unreachable, gateway failure, or unparseable LLM output → stub/placeholder instead of error. The LMS frontend handles degraded responses gracefully.

---

## LMS Integration Points

Shared client: `workers/shared/fetch-lms.ts`. Auth: `X-API-Key` header.

| Worker | LMS Endpoints Called |
|--------|---------------------|
| ai-indexing | `/v1/lessons/{id}` (metadata enrichment) |
| ai-tutor | `/v1/lessons/{id}` (citation metadata) |
| ai-paths | `/v1/learner/profile`, `/v1/catalog`, `/v1/progress/user` |
| ai-recommendations | `/v1/courses/recommendations`, `/v1/learner/profile`, `/v1/catalog`, `/v1/progress/user` |
| ai-insights | `/v1/learner/assessments/{id}`, `/v1/learner/assessments/attempts/{id}`, `/v1/progress/user`, `/v1/modules/{id}/lessons`, `/v1/learner/assessments/summary` |
| ai-assistant | `/v1/catalog`, `/v1/learner/profile` |
| ai-mentor | `/v1/learner/profile`, `/v1/catalog`, `/v1/progress/user` |
| ai-bottlenecks | `/v1/admin/progress/aggregate`, `/v1/admin/assessments/aggregate` |
| ai-engagement | `/v1/admin/engagement` |
| ai-analytics | `/v1/admin/progress/aggregate`, `/v1/admin/assessments/aggregate`, `/v1/admin/engagement` |
| ai-question-gen | `/v1/lessons/{id}` (lesson content) |
| ai-quality | (LLM-only, no LMS calls) |

---

## Resource Map

| Resource | Type | Used By | Purpose |
|----------|------|---------|---------|
| `lms-lessons` | Vectorize (1024-dim) | indexing, tutor, recs, assistant, question-gen | Embedded lesson content + similarity |
| `indexing-jobs` | Queue | ai-indexing | Async indexing (batch_size=3, retry 3x) |
| `TutorSession` | Durable Object | ai-tutor | Per-learner conversation state (SQLite) |
| `AssistantSession` | Durable Object | ai-assistant | Per-learner assistant state (SQLite) |
| `lms-content-staging` | R2 Bucket | ai-indexing | PDF/PPT/video storage |
| `lms-platform` | D1 Database | ai-gateway | Org budget tracking |
| `LMS_CACHE` | KV Namespace | recs, assistant, dashboard | 24h TTL cache |
| `unpdf` | npm package | ai-indexing | PDF text extraction in Worker |

---

## Internal Service Bindings

| Binding | Used By |
|---------|---------|
| `AI_GATEWAY` → ai-gateway | All 12 frontend workers |
| `VECTORIZE_INDEX` → `lms-lessons` | indexing, tutor, recs, assistant, question-gen |
| `TUTOR_SESSION` → TutorSession DO | ai-tutor |
| `ASSISTANT_SESSION` → AssistantSession DO | ai-assistant |
| `LMS_CACHE` → KV | recs, assistant |
| `INDEXING_QUEUE` → `indexing-jobs` | ai-indexing |
| `STREAM`, `LMS_CONTENT` | ai-indexing |
