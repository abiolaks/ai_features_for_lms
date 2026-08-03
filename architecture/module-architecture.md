# Module Architecture — AI Workers (Cloudflare)

> Last updated: 2026-07-18. Reflects what is actually deployed, not planned.

---

## Deployed Workers

| Worker | URL | Status | Key Technology |
|--------|-----|--------|---------------|
| `ai-gateway` | `ai-gateway.yomi-alarape.workers.dev` | ✅ Live | Workers AI (llama-3.2-3b), D1 budget tracking |
| `ai-indexing` | `ai-indexing.yomi-alarape.workers.dev` | ✅ Live | Queue consumer, Vectorize, Stream VTT extraction |
| `ai-tutor` | `ai-tutor.yomi-alarape.workers.dev` | ✅ Live | Durable Objects (SQLite), WebSocket streaming |
| `ai-paths` | `ai-paths.yomi-alarape.workers.dev` | ✅ Live | Service binding to ai-gateway |
| `ai-insights` | `ai-insights.yomi-alarape.workers.dev` | ✅ Live | 30/30 tests, quiz analysis + review links |
| `ai-recommendations` | `ai-recommendations.yomi-alarape.workers.dev` | ✅ Live | 23/23 tests, enhance + engine tiers, KV cache |
| `ai-assistant` | `ai-assistant.yomi-alarape.workers.dev` | ✅ Live | 37/37 tests, DO (SQLite), RAG retrieval, course suggestions |
| `ai-mentor` | `mentor.yomi-alarape.workers.dev` | ✅ Live | 29/29 tests, skill-gap analysis, service binding to ai-gateway |
| `ai-dashboard` | `ai-dashboard.pages.dev` | ⏳ Built | Pages static site, 6 worker cards |

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          LMS Backend (Python)                            │
│                                                                          │
│  On lesson publish:                                                      │
│    POST /index ── X-Webhook-Secret ──────────────────────────────────┐   │
│                                                                      │   │
│  On lesson unpublish:                                                 │   │
│    POST /deindex ── X-Webhook-Secret ────────────────────────────────┤   │
│                                                                      │   │
│  Bulk re-index:                                                       │   │
│    POST /backfill ── X-Webhook-Secret ───────────────────────────────┤   │
└──────────────────────────────────────────────────────────────────────┼───┘
                                                                       │
┌──────────────────────────────────────────────────────────────────────▼───┐
│                        ai-indexing Worker                                │
│                                                                          │
│  ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐  │
│  │  Fetch Handler  │     │  Queue Consumer  │     │  Diagnostics     │  │
│  │                 │     │                  │     │                  │  │
│  │ /index  → queue │     │ queue(batch,env) │     │ GET /videos      │  │
│  │ /deindex→ direct│     │  → handleIndex() │     │ GET /captions/:id│  │
│  │ /backfill→ queue│     │  → chunkText()   │     │ GET /diag-index  │  │
│  └────────┬────────┘     │  → embedAndUpsert│     │ GET /diag-deindex│  │
│           │              └────────┬─────────┘     └──────────────────┘  │
│           │                       │                                      │
│           │    ┌──────────────────▼──────────────────────────────┐       │
│           │    │  indexing-jobs Queue                            │       │
│           │    │  batch_size=3, max_retries=3, timeout=60s       │       │
│           └───▶│  Auto-retries failed jobs. LMS gets 202 instantly│      │
│                └─────────────────────────────────────────────────┘       │
│                                                                          │
│  Bindings: AI (bge-large-en-v1.5), Vectorize (lms-lessons),              │
│            Stream, INDEXING_QUEUE (indexing-jobs)                        │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Vectorize: lms-lessons                               │
│                     1024-dim cosine, ~30 vectors                         │
│                                                                          │
│  Each vector: { id, values, metadata: { title, lesson_id, course_id,    │
│    org_id, content_type, chunk_index, total_chunks, content, ... } }     │
│                                                                          │
│  Content chunked at ~2000 chars (10KB metadata limit).                   │
│  6 videos indexed (Jira 11 chunks, LumeraXCourse 4 chunks, others 1).   │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        ai-tutor Worker                                   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Fetch Handler (stateless routing)                                │   │
│  │                                                                   │   │
│  │  POST /tutor/ask ──▶ DO.ask()          (HTTP, non-streaming)     │   │
│  │  POST /tutor/clear ─▶ DO.clearHistory()                          │   │
│  │  GET  /tutor/ws   ──▶ DO.fetch()        (WebSocket upgrade)      │   │
│  └──────────────────────────┬───────────────────────────────────────┘   │
│                             │                                            │
│  ┌──────────────────────────▼───────────────────────────────────────┐   │
│  │  TutorSession Durable Object (one per learner)                    │   │
│  │                                                                    │   │
│  │  ┌──────────────────┐    ┌──────────────────────────────────┐    │   │
│  │  │  SQLite Storage  │    │  In-Memory (during streaming)    │    │   │
│  │  │                  │    │                                  │    │   │
│  │  │  messages table  │    │  this.currentAnswer = ""         │    │   │
│  │  │  role | content  │    │  Accumulated during WS stream    │    │   │
│  │  │  user | "..."
│  │  │  assistant | ".."│    └──────────────────────────────────┘    │   │
│  │  │                  │                                            │   │
│  │  │  ← persists      │    RPC Methods:                            │   │
│  │  │    across        │      ask(body) → Response                  │   │
│  │  │    crashes       │      clearHistory() → Response             │   │
│  │  │    deployments   │                                            │   │
│  │  │    evictions     │    WebSocket:                              │   │
│  │  │                  │      fetch() — upgrade handler             │   │
│  │  │  MAX 20 msgs     │      webSocketMessage() — ask/cancel       │   │
│  │  │  auto-prune      │      webSocketClose/Error()                │   │
│  │  └──────────────────┘    └──────────────────────────────────┘    │   │
│  │                                                                    │   │
│  │  Processing flow (shared by HTTP and WS):                         │   │
│  │    1. Load history from SQLite                                    │   │
│  │    2. Embed question → bge-large-en-v1.5                         │   │
│  │    3. Query Vectorize (post-filter by org/lesson)                 │   │
│  │    4. Build prompt: [History] + [Content] + [Question]           │   │
│  │    5. Call ai-gateway (service binding)                           │   │
│  │    6. HTTP: return full response / WS: stream tokens             │   │
│  │    7. Save exchange to SQLite                                     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Bindings: AI, Vectorize, AI_GATEWAY (service),                         │
│            TUTOR_SESSION (Durable Object)                                │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        ai-gateway Worker                                 │
│                                                                          │
│  POST /generate  → env.AI.run(model, {messages})  → JSON response       │
│  POST /stream    → env.AI.run(model, {stream:true}) → SSE stream        │
│                                                                          │
│  Budget tracking: D1 (org_budgets table)                                 │
│    - Check budget before each call                                       │
│    - Track tokens after response                                         │
│    - 429 if exhausted                                                    │
│                                                                          │
│  Models:                                                                 │
│    standard: @cf/meta/llama-3.2-3b-instruct (1024 max tokens)           │
│    quality:  @cf/mistral/mistral-7b-instruct-v0.2-lora (2048 max)       │
│                                                                          │
│  Streaming: stream.tee() + TransformStream                               │
│    - Side-reader accumulates full response + token count                 │
│    - Main pipe re-emits as {type:"token",text:"..."}                     │
│    - Flush sends {type:"done",response:"...",tokens_used:N}              │
│                                                                          │
│  Bindings: AI, DB (D1), LMS_CACHE (KV)                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Key Architectural Decisions

### 1. Durable Objects for Conversation State

**Decision:** Each learner gets a dedicated Durable Object (DO) with SQLite storage for conversation history.

**Why:**
- Without DOs, every `POST /tutor/ask` is stateless — the LLM has no memory of previous questions
- A learner asking "Give me an example" has no context unless history is stored
- DOs provide single-threaded, strongly-consistent state per learner
- SQLite persists across DO evictions, crashes, and worker redeploys
- Deterministic routing (`idFromName`) ensures the same learner always reaches their DO

**Trade-off:** Cold starts (~100ms) if DO was evicted from memory. Mitigated by keeping DOs warm via periodic requests.

### 2. WebSocket Streaming (not just HTTP request-response)

**Decision:** Added `GET /tutor/ws` WebSocket endpoint. Streams LLM tokens as they're generated.

**Why:**
- HTTP: learner stares at spinner for 3-8 seconds → feels broken
- WebSocket: words appear in ~500ms → feels like ChatGPT
- Same DO serves both HTTP and WebSocket — conversation persists across connection types
- Citations sent first (before tokens) so UI shows sources immediately

**Trade-off:** WebSocket connections are stateful (need connection management). HTTP fallback always available.

### 3. Queue-Based Async Indexing

**Decision:** `POST /index` pushes to a Cloudflare Queue. Consumer processes jobs asynchronously.

**Why:**
- Synchronous indexing takes 5-120 seconds (VTT fetch + embedding). Workers have 30s CPU limit.
- Queue returns 202 instantly — LMS doesn't wait
- Auto-retry: failed embeddings retry up to 3 times
- Parallelism: batch_size=3 processes multiple videos concurrently
- Backpressure: if 100 lessons are published, queue absorbs the burst

**Trade-off:** No callback to LMS when indexing completes. Check Worker logs for status.

### 4. Transcript Chunking (2000 chars, sentence boundaries)

**Decision:** Split transcripts into ~2000-character chunks, each stored as a separate Vectorize vector.

**Why:**
- Vectorize metadata limit: 10,240 bytes per vector
- Long videos (20 min Jira tutorial = 21KB transcript) exceed this in a single vector
- Chunking at sentence boundaries preserves semantic coherence
- Each chunk tagged with `chunk_index` / `total_chunks` for reassembly
- Pre-cleanup of old vectors on re-index prevents duplicates

**Trade-off:** 11 vectors for one video vs 1. Query aggregates across chunks via post-filter.

### 5. Embedding Model: bge-large-en-v1.5 (1024-dim)

**Decision:** Switched from `@cf/qwen/qwen3-embedding-0.6b` (384-dim) to `@cf/baai/bge-large-en-v1.5` (1024-dim).

**Why:**
- Vectorize index `lms-lessons` was created at 1024 dimensions
- qwen3 outputs 384-dim — dimension mismatch caused silent failures and garbage vectors
- bge-large matches the index dimension and provides higher-quality embeddings
- Both `ai-indexing` and `ai-tutor` must use the same model for consistent query results

**Trade-off:** bge-large is slower and more expensive than qwen3 (larger model). Acceptable for current scale.

### 6. Direct Vectorize (No AI Search)

**Decision:** Use Workers AI embedding + direct Vectorize upsert. No Cloudflare AI Search dependency.

**Why:**
- AI Search (beta) consistently failed to persist vectors — indexing jobs stalled indefinitely
- Direct Vectorize is instant (no indexing job), mature, and gives full control over metadata
- We handle chunking ourselves (2000 chars, sentence boundaries)
- We handle metadata filtering ourselves (post-filter until Vectorize indexes propagate)

**Trade-off:** No auto-chunking, no hybrid search, no auto-reranking from AI Search. Re-add these manually later if needed.

### 7. Service Bindings for Inter-Worker Communication

**Decision:** Workers communicate via Cloudflare service bindings, not public URLs.

**Why:**
- `ai-tutor` → `ai-gateway`: service binding avoids public exposure of the gateway
- `ai-paths` → `ai-gateway`: same pattern
- Lower latency (internal network), no DNS resolution
- No auth needed between trusted workers

**Trade-off:** Tight coupling — workers must be deployed in the same Cloudflare account.

### 8. PDF/PPT Extraction via unpdf in Worker (not LMS, not Python)

**Decision:** Use `unpdf` (Workers-compatible PDF.js wrapper) directly in the `ai-indexing` Worker. PDFs are fetched from R2, extracted, and indexed — all in the Worker. No LMS extraction code needed.

**Why:**
- `unpdf` is purpose-built for Cloudflare Workers (1.4M weekly downloads, keywords: "cloudflare", "workers", "edge")
- Handles FlateDecode compression — works on 95%+ of real-world PDFs (all 31 R2 PDFs)
- Zero LMS dependency — LMS just calls `/extract-pdf` with an R2 key
- Simpler than Python Worker approach (no Pyodide package issues, no separate service)

**Four failed approaches before finding unpdf:**
1. BT/ET regex — only works on uncompressed PDFs (<5% of real-world PDFs)
2. pdf-parse npm — depends on Node.js Buffer, not available in Workers
3. Python Worker with PyPDF2 — PyPDF2 not in Pyodide's package list
4. Checked Pyodide repodata — PyPDF2 can't be added without custom build

**How it works:**
```
LMS: POST /extract-pdf { r2Key: "courses/module-4.pdf" }
  ↓
ai-indexing Worker:
  → env.LMS_CONTENT.get(r2Key)          // fetch from R2
  → unpdf.extractText(pdf, {mergePages}) // decompress + extract
  → env.INDEXING_QUEUE.send({entity})    // queue for chunk+embed
  → 202 Accepted (instant)
  ↓
Queue consumer:
  → chunkText() → embed() → Vectorize
```

**Bundle impact:** 2.3MB total (unpdf ~1.1MB), under Workers' 3MB limit.

**Trade-off:** Larger bundle size, slightly slower cold starts. Acceptable trade for zero LMS dependency and real PDF text extraction.

---

## Data Flow: Question → Answer (End-to-End)

```
1. Learner types question in browser
2. Frontend opens WebSocket: wss://ai-tutor.../tutor/ws?learner_id=user-42
3. Frontend sends: {"type":"ask","question":"How do list comprehensions work?",...}
4. ai-tutor Worker routes to TutorSession DO (session-user-42)
5. DO loads conversation history from SQLite (previous exchanges)
6. DO embeds question via Workers AI → bge-large-en-v1.5 → 1024-dim vector
7. DO queries Vectorize (lms-lessons) → top 15 matches
8. DO post-filters by org_id + lesson_id + score > 0.1
9. DO builds prompt: [History context] + [Source: Title, excerpt] + [Question]
10. DO calls ai-gateway /stream (service binding)
11. ai-gateway calls Workers AI (llama-3.2-3b) with stream:true
12. Tokens flow back: gateway → DO → WebSocket → browser
13. DO saves exchange (question + answer) to SQLite
14. Browser displays: "List comprehensions use [expr for item...] [Python, Page 12]"

## Data Flow: PDF → Indexed → Searchable

```
1. LMS calls /extract-pdf with R2 key
2. ai-indexing fetches PDF from R2 (lms-content-staging)
3. unpdf decompresses + extracts text (handles FlateDecode)
4. Worker pushes { entity: { content: "...12K chars..." } } to queue → 202
5. Queue consumer picks up job
6. chunkText() splits at 2000-char sentence boundaries
7. embedAndUpsert() → bge-large-en-v1.5 → 1024-dim vectors → Vectorize
8. Each chunk has metadata: { content_type: "pdf", lesson_id, title, chunk_index, total_chunks }
9. Learner asks tutor → embed question → search Vectorize
10. Tutor returns grounded answer with citations from PDF content
```
```

---

## Resource Map (Cloudflare)

| Resource | Type | Used By | Purpose |
|----------|------|---------|---------|
| `lms-lessons` | Vectorize Index (1024-dim) | ai-indexing, ai-tutor, ai-recommendations | Embedded lesson content + content similarity scoring |
| `indexing-jobs` | Queue | ai-indexing | Async indexing pipeline (batch_size=3, retry 3x) |
| `TutorSession` | Durable Object | ai-tutor | Per-learner conversation state (SQLite) |
| `lms-content-staging` | R2 Bucket | ai-indexing | PDF/PPT/document storage |
| `lms-platform` | D1 Database | ai-gateway | Org budget tracking (org_budgets table) |
| `LMS_CACHE` | KV Namespace | ai-recommendations | 24h TTL recommendation cache |
| `unpdf` | npm package (1.1MB) | ai-indexing | PDF text extraction (PDF.js for Workers) |
| `CLOUDFLARE_STREAM_API_TOKEN` | Secret | ai-indexing | Fetch VTT captions from Stream |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | ai-indexing | Stream API account |
| `LMS_WEBHOOK_SECRET` | Secret | ai-indexing | Authenticate LMS webhooks |

---

## Scope Expansion Flow (Tutor)

```
Default: lesson scope
  filter: { lesson_id, org_id }
    │
    ├── Content found → return answer
    └── No content → scope_expansion_suggested: true
                      │
                      ▼
                  Module scope
                  filter: { module_id, course_id, org_id }
                      │
                      ├── Content found → return answer
                      └── No content → scope_expansion_suggested: true
                                        │
                                        ▼
                                    Course scope
                                    filter: { course_id, org_id }
```

## LMS Integration Points

All AI Workers read from LMS via `GET /api/v1/...` with `LMS_INTERNAL_KEY`.
The shared client is at `workers/shared/fetch-lms.ts`.

| Worker | LMS Endpoints Called |
|--------|---------------------|
| ai-indexing | `/v1/lessons/{id}` (metadata enrichment) |
| ai-tutor | `/v1/lessons/{id}` (citation metadata) |
| ai-paths | `/v1/learner/profile`, `/v1/catalog`, `/v1/progress/user` |
| ai-recommendations | `/v1/courses/recommendations`, `/v1/learner/profile`, `/v1/catalog`, `/v1/progress/user` |
| ai-insights | `/v1/learner/assessments/{id}`, `/v1/learner/assessments/attempts/{id}`, `/v1/progress/user`, `/v1/modules/{id}/lessons`, `/v1/learner/assessments/summary` |
| ai-assistant | `/v1/catalog`, `/v1/learner/profile` |
| ai-mentor | `/v1/learner/profile`, `/v1/catalog`, `/v1/progress/user` |

---

## Phase 2 Workers

### F03a: Skill-Gap Analysis (ai-mentor)

`GET /mentor/skill-gap?learner_id=&org_id=`

```
LMS Frontend
GET /mentor/skill-gap
  ↓
ai-mentor Worker:
  1. Fetch learner profile → preferences for skills/goals
  2. Fetch catalogue → course prerequisites + estimated_hours
  3. Fetch progress → exclude completed courses
  4. Map learner skills against catalogue requirements
  5. Call ai-gateway → structured gap analysis
  6. Return { gaps, summary } with courses_available + estimated_hours
```

**Degraded:** Empty profile → suggests adding skills. Gateway down → keyword matching.

### F03b: Session Prep Insights (ai-insights)

`POST /insights/mentor/session-prep`

```
LMS Frontend
POST /insights/mentor/session-prep { learner_id, mentor_id, org_id }
  ↓
ai-insights Worker:
  1. Fetch profile + progress + assessment summary from LMS
  2. Identify: stalled modules (<30% progress), lowest quiz topics
  3. Build prompt with progress + quiz data
  4. Call ai-gateway → 3-topic agenda prioritized by urgency
  5. Return { recent_activity, suggested_agenda, prep_materials }
```

**Degraded:** Skeleton agenda when no LMS data or gateway down.

### F06: Platform Assistant (ai-assistant)

`POST /assistant/ask`, `POST /assistant/clear`

```
  Fetch Handler:
    POST /assistant/ask   ──▶ DO.ask(body)    (multi-turn)
    POST /assistant/clear ──▶ DO.clearHistory()
                              │
  AssistantSession Durable Object (one per learner):
    1. Load history from SQLite (MAX 20 msgs)
    2. Embed question → query Vectorize (no lesson filter — all courses)
    3. Fetch catalogue from LMS
    4. Build prompt: [History] + [Content] + [Catalogue]
    5. Call ai-gateway → answer + course suggestions
    6. Save exchange to SQLite

  Differences from Tutor:
  - Course scope (not lesson-scoped)
  - Returns suggested_courses
  - One DO per learner across ALL courses (not per course)
  - Prompt injection defense
```
