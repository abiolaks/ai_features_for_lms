## Session: — AI04: WebSocket Streaming for Real-Time Tutor Responses

**Question:** Does the ai-tutor have WebSocket streaming so words appear in real-time like ChatGPT?

**Answer — Before:** No. The tutor worked like email — send question, wait 3-8 seconds, get full answer. Learner stares at a spinner.

**Answer — After:** Yes. Implemented end-to-end streaming from Workers AI → Gateway → Durable Object → WebSocket → Client.

### Architecture

```
Client WebSocket                    ai-tutor Worker              ai-gateway Worker
───────────────                     ──────────────               ─────────────────
GET /tutor/ws?learner_id=X ──────▶ forward to DO ──▶ TutorSession.fetch()
  ◀── 101 Upgrade ─────────────────────────────────── acceptWebSocket()
  
  {"type":"ask","question":"..."} ──▶ webSocketMessage()
                                      │ embed → Vectorize
                                      │ buildPrompt(history, citations)
                                      │ POST /stream ──────────────▶ env.AI.run(stream:true)
                                      │                              aiStreamToSSE()
                                      │ ◀── SSE tokens ───────────── {type:"token",text:"..."}
                                      │ ◀── SSE done ─────────────── {type:"done",...}
  ◀── {"type":"citations",...} ────── send citations first
  ◀── {"type":"token","text":"Jira"} ─ stream tokens
  ◀── {"type":"token","text":" is"}
  ◀── {"type":"token","text":" a"}
  ◀── {"type":"done","history_length":4}
                                      │ saveExchange(question, answer)
```

### Protocol

| Direction | Message | When |
|-----------|---------|------|
| Client → Server | `{"type":"ask","question":"...","lesson_id":"...","course_id":"...","org_id":"..."}` | Ask a question |
| Server → Client | `{"type":"citations","citations":[{...}]}` | Sources found (sent before streaming starts) |
| Server → Client | `{"type":"token","text":"word"}` | Each token as LLM generates it |
| Server → Client | `{"type":"done","answer":"...","history_length":N}` | Stream complete, exchange saved |
| Client → Server | `{"type":"cancel"}` | Stop generation (stub — not yet interrupting stream) |
| Server → Client | `{"type":"error","error":"..."}` | Any error |

### Streaming Pipeline

1. **Gateway (`POST /stream`):** Calls Workers AI with `stream: true`. Returns a `ReadableStream`. The `aiStreamToSSE()` transform uses `stream.tee()` + `TransformStream` to:
   - Side-reader accumulates full response + token count
   - Main reader re-emits each Workers AI SSE chunk as `{"type":"token","text":"..."}`
   - `flush()` sends `{"type":"done","response":"...","tokens_used":N}` and tracks tokens in D1

2. **DO (`TutorSession.webSocketMessage`):** Receives `{"type":"ask"}`, does embedding + Vectorize search, builds prompt with conversation history, calls gateway `/stream` via service binding, reads the SSE stream, forwards each token through the WebSocket.

3. **Worker (`GET /tutor/ws`):** Receives WebSocket upgrade, creates DO stub via `idFromName`, forwards to `session.fetch()` which handles the upgrade.

### Backward Compatibility

`POST /tutor/ask` (HTTP, non-streaming) still works — uses the same `buildGroundedPrompt()` shared helper. Returns full response as JSON with `history_length`.

### Key Implementation Details

- **Token accumulation:** The DO accumulates tokens during streaming, then saves the full exchange to SQLite on stream completion. If the stream errors, the partial answer is not saved.
- **Citations first:** Sources are sent before tokens start streaming so the UI can show "Based on: LumeraUnit1, Jira_Tutorial" immediately.
- **History management:** WebSocket and HTTP paths share the same `loadHistory()`/`saveExchange()` methods. History limit of 20 messages with auto-prune.
- **`stream.tee()`:** Used in gateway to split the Workers AI stream — one branch for accumulation, one for client delivery. This avoids buffering the full response.

### UX Implication

Without streaming: 3-8 second spinner, feels broken. With streaming: words appear in ~500ms, feels like ChatGPT. Same total time, dramatically different perceived performance.

**Related files:**
- `workers/ai-gateway/src/index.ts` (`handleStream`, `aiStreamToSSE`)
- `workers/ai-tutor/src/TutorSession.ts` (`fetch`, `webSocketMessage`, `handleStreamAsk`)
- `workers/ai-tutor/src/index.ts` (WebSocket upgrade route)
- `workers/ai-tutor/wrangler.jsonc` (DO binding + migration)

---

## Session: — Content Indexing Pipeline: Chunking, Embedding Model Fix, Stream Video Indexing

**Context:** 9 videos in Cloudflare Stream, only 2 had captions. 5 had no captions (auto-generation works). The Jira tutorial (20 min) produced 21KB of transcript — too large for Vectorize metadata limit (10,240 bytes).

**Embedding Model Dimension Mismatch:**
- Vectorize index `lms-lessons` was created with 1024 dimensions
- Code used `@cf/qwen/qwen3-embedding-0.6b` (384-dim)
- Upserts were silently failing or producing garbage vectors
- **Fix:** Switched to `@cf/baai/bge-large-en-v1.5` (1024-dim) in both `ai-indexing` and `ai-tutor`

**Transcript Chunking:**
- Vectorize metadata limit: 10,240 bytes per vector
- Long transcripts (20 min video = 21KB) exceeded this
- **Fix:** `chunkText()` splits content at ~2000 chars, breaking at sentence boundaries
- Each chunk gets its own vector with `chunk_index`, `total_chunks`, shared `lesson_id`
- Vector IDs: `lesson-{id}-chunk0`, `lesson-{id}-chunk1`, ...
- `embedAndUpsert()` batches upserts in groups of 10 (Vectorize limit)
- Pre-cleanup: deletes old vectors before re-indexing (batched `getByIds`, 20-ID limit)

**Indexing Results:**
| Video | Duration | Chunks | Source |
|-------|----------|--------|--------|
| Jira Tutorial | 20 min | 11 | existing captions |
| LumeraUnit1 | 57s | 1 | existing captions |
| AI Instructor | 10s | 1 | existing captions |
| LumeraXCourse | 9 min | 4 | AI-generated captions |
| LumeraX Avatar | 39s | 1 | AI-generated captions |
| Animated logos ×2 | 8s | 1 each | AI-generated (minimal) |

**Tutor adaptation:**
- `TOP_K` increased from 5 → 15 (multi-chunk videos need more matches)
- `EXCERPT_MAX_LEN` increased from 300 → 2000 (give LLM full chunk context)

**Related files:**
- `workers/ai-indexing/src/index.ts` (`chunkText`, `embedAndUpsert`, `handleVideoIndex`)
- `workers/ai-tutor/src/index.ts` (`TOP_K`, `EXCERPT_MAX_LEN`)

---

## Session: — PDF & PPT Content Indexing Spec (for Backend)

**Question:** How will PDF and PPT courses be indexed? How do citations work for non-video content?

**Answer:** LMS backend extracts text (Python PDF/PPT libraries), sends inline in webhook payload as `entity.content`. Worker chunks, embeds, stores with content type metadata. Tutor cites as `[Title, Page X]` or `[Title, Slide X]`.

**Why not parse PDFs in the Worker:**
- JS PDF parsing is fragile (complex layouts break)
- No OCR support
- bloats worker bundle (pdf-parse is ~1MB, 3MB limit)
- Python has mature, reliable PDF libraries (PyPDF2, pdfplumber, python-pptx)

**LMS responsibility:** Extract text with PyPDF2/pdfplumber (PDF) or python-pptx (PPT), send as `entity.content` in the `/index` webhook.

**Worker responsibility:** Read `entity.content` (1-line change), chunk if needed, embed, store with `content_type: "pdf"`/`"ppt"` metadata.

**Citation format:**
```json
{
  "source_title": "Intro to Python",
  "source_type": "pdf",
  "location": "Page 12",
  "excerpt": "List comprehensions provide...",
  "score": 0.91
}
```

**Full spec in:** `docs/lms-api-contract-for-backend.md` → "PDF & PPT Content Indexing" section.

---

## Session: — AI06: Learning Paths — Observability Spans

**What was implemented:**
- Added structured console.log span helpers (`startSpan`, `setAttr`, `endSpan`)
- Two top-level spans: `data.fetch` (profile + catalogue + progress) and `path.generate` (LLM call + validation)
- Sub-span: `ai_gateway.generate` (tier, status, duration)
- `path.generate` attributes: `course_count`, `why_this_fits_count`, `prereq_violations`, `llm_model`, `llm_tokens`, `ai_status`
- `data.fetch` attributes: `catalogue_courses`, `progress_entries`, `has_profile`, `learner_id`, `org_id`
- LMS fetch spans (`lms.fetch`) are commented out — ready when LMS is live
- Prerequisite validator now tracks `prereq_violations` count → surfaced in span
- 6 new span tests added (20/20 passing)

**LMS APIs AI06 needs (documented for backend team):**
1. `GET /v1/learner/profile` — skills, goals, experience_level, streak_days, points
2. `GET /v1/catalog?org_id=X` — published courses with difficulty, category, prerequisites
3. `GET /v1/progress/user?userId=X` — enrollments with status + progress_pct

Gaps in current api.json: no `prerequisites` field on CourseResource, no `goals`/`experience_level`/`skills` on profile.

**Related files:**
- `workers/ai-paths/src/index.ts` (spans added, prereq violation tracking)
- `workers/ai-paths/test/index.test.ts` (6 new span tests)
- `docs/lms-api-contract-for-backend.md` (new — full contract for LMS team)
- `docs/api-contract.md` (updated — added AI06 endpoint docs)

---

## Session: — LMS Webhook Secret Setup

**Secret generated:** `LMS_WEBHOOK_SECRET` (64-char hex via `openssl rand -hex 32`)
**Set on:** `ai-indexing` worker via `wrangler secret put`
**Validation added:** `ai-indexing/src/index.ts` now checks `X-Webhook-Secret` header on all POST requests to `/index`, `/deindex`, `/backfill`
**Tests:** 17/17 passing (added 2 auth tests — missing secret → 401, wrong secret → 401)
**Deployed:** `ai-indexing` deployed with webhook auth active

**Secret exchange flow:**
- AI team generates `LMS_WEBHOOK_SECRET` → shares with LMS team
- LMS team generates `LMS_INTERNAL_KEY` → shares with AI team
- LMS team provides `LMS_GATEWAY_URL` (their public URL, e.g. `https://lms-dev-xyz.trycloudflare.com`)

**How LMS team uses webhook:**
```bash
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -H "X-Webhook-Secret: <secret>" \
  -H "Content-Type: application/json" \
  -d '{ "event":"publish", "org_id":"org-wragby", "entity":{...} }'
```

**Related files:**
- `workers/ai-indexing/src/index.ts` (Env interface + auth check)
- `workers/ai-indexing/test/index.test.ts` (webhook auth tests)
- `docs/lms-api-contract-for-backend.md` (full webhook + LMS API docs for backend team)

---

## Session: — Contract: What the Backend Engineer Needs

**Your URLs (for development):**
```
https://ai-indexing.yomi-alarape.workers.dev   ← POST /index, /deindex
https://ai-tutor.yomi-alarape.workers.dev      ← POST /tutor/ask
https://ai-gateway.yomi-alarape.workers.dev    ← Internal only (tutor calls this)
```

**What the backend engineer sends:**
1. `POST /index` — when a lesson is published: `{ event:"publish", org_id, entity: { id, title, contentType, cloudflareVideoId, streamStatus, course_id, module_id?, durationSeconds } }`
2. `POST /deindex` — when unpublished: `{ event:"unpublish", org_id, entity: { id } }`
3. `POST /tutor/ask` — when learner asks: `{ question, lesson_id, course_id, org_id, expand_scope? }`

**What he gets back:**
- `/index` → `{ status:"indexed", transcript_source, content_length }`
- `/tutor/ask` → `{ answer, citations: [{ lesson_title, excerpt, score }], scope_expansion_suggested }`

**For production:** Switch from `.workers.dev` to custom domain. Single gateway worker pattern gives one clean URL: `https://ai.lms.example.com/index` etc.

**What he does NOT need to know:** Vectorize, embedding model, VTT extraction, prompt construction, AI03 gateway.

---

## Session: — AI04 Prompt Tuning: "ONLY" vs "based on"

**Symptom:** LLM returned "I couldn't find that" even when relevant transcript content was provided in the prompt (score 0.526, excerpt about AI reshaping business).

**Root cause:** The grounded prompt said "Answer the question using ONLY the provided content" with a fallback of "If the answer is not in the content, say I couldn't find that." Llama-3.2-3b interpreted this too conservatively — it chose to reject rather than summarize.

**Fix:** Changed prompt to "Answer the question based on the provided content below." and moved the rejection instruction to "If the content is irrelevant to the question." This encourages summarization while still preventing hallucination.

**Before:** `"Answer the question using ONLY the provided content below."`
**After:** `"Answer the question based on the provided content below."`

**Test queries for live verification:**
```bash
# AI in business (matches Lumera transcript) — should return grounded answer
curl -X POST .../tutor/ask -d '{"question":"how is AI reshaping business?","lesson_id":"lumera-u1",...}'

# What is Python? (matches py-intro) — should return grounded answer
curl -X POST .../tutor/ask -d '{"question":"What is Python?","lesson_id":"py-intro",...}'

# Quantum computing (not in any lesson) — should return "couldn't find"
curl -X POST .../tutor/ask -d '{"question":"What is quantum computing?","lesson_id":"lumera-u1",...}'

# Course scope — searches both lessons
curl -X POST .../tutor/ask -d '{"question":"What is this about?","expand_scope":"course"}'

# Trust in AI (in the transcript)
curl -X POST .../tutor/ask -d '{"question":"why is trust important in AI?",...}'
```

**Related files:** `workers/ai-tutor/src/index.ts` (buildPrompt function)

---

## Session: — Production Readiness Checklist (LMS Integration + Cleanup)

**AI01 markers** (search `LMS_INTEGRATION` in `workers/ai-indexing/src/index.ts`):
1. Webhook verification — uncomment signature check, needs `LMS_WEBHOOK_SECRET`
2. Metadata enrichment — uncomment LMS API fetch, needs `LMS_GATEWAY_URL` + `LMS_INTERNAL_KEY`

**AI04 markers** (search `LMS_INTEGRATION` in `workers/ai-tutor/src/index.ts`):
3. Fetch lesson metadata — replace Vectorize-as-metadata-source with LMS API call

**Temporary workarounds to remove:**
4. Post-filter (AI04 ~line 115) → replace with native Vectorize `filter:` param once metadata indexes propagate
5. Score threshold 0.1 (AI04 ~line 20) → raise to 0.5 once more content is indexed

**Secrets to set when LMS is live:**
- `LMS_WEBHOOK_SECRET` — verify incoming webhooks
- `LMS_GATEWAY_URL` — LMS REST API base URL
- `LMS_INTERNAL_KEY` — X-API-Key auth header

---

## Session: — LMS Integration Points in ai-indexing (stub markers)

**Question:** Where in the code do I add LMS API calls and secrets later?

**Answer:** Two `LMS_INTEGRATION` comment blocks in `workers/ai-indexing/src/index.ts` → `handleIndex()`:

1. **Webhook verification** (uses `LMS_WEBHOOK_SECRET`) — validates X-Webhook-Signature header
2. **Metadata enrichment** (uses `LMS_GATEWAY_URL` + `LMS_INTERNAL_KEY`) — fetches additional lesson metadata from LMS REST API

**Secrets needed when LMS is live:**
| Secret | Purpose |
|--------|---------|
| `LMS_WEBHOOK_SECRET` | Verify incoming webhooks |
| `LMS_GATEWAY_URL` | LMS REST API base URL |
| `LMS_INTERNAL_KEY` | `X-API-Key` auth header |

All set via `npx wrangler secret put`. No wrangler.jsonc changes needed — env vars are already referenced in the code comments.

**Related files:**
- `workers/ai-indexing/src/index.ts` (lines ~228–248, search `LMS_INTEGRATION`)
- `architecture/module-architecture.md` (updated to reflect Vectorize)

---

## Session: — DECISION: Direct Vectorize over AI Search (beta bug workaround)

**Context:** AI Search (beta) consistently failed to persist vectors to Vectorize. The "builtin" type with `items.upload()` and "r2" type both generated embeddings but stalled on "pending Vectorize ingestion confirmation" indefinitely. Five attempts across different instance types, fresh instances, and configs all failed.

**Decision:** Bypass AI Search entirely. Use Workers AI (`@cf/qwen/qwen3-embedding-0.6b`) to embed content ourselves, upsert directly to our own Vectorize index (`lms-lessons`, 1024-dim cosine metric). This is simpler, instant (no indexing job needed), and uses mature stable APIs.

**Trade-offs:**
- Gain: 1024-dim vectors (vs AI Search's 384), instant upsert, no indexing jobs, full control over metadata
- Lose: No auto-chunking (we'll add when content exceeds model ctx window), no hybrid search (re-add later via keyword index), no auto-reranking

**Pipeline:** `Stream → VTT → transcript → env.AI.run(embedding_model) → env.VECTORIZE_INDEX.upsert([{id, values, metadata: {title, lesson_id, course_id, org_id, content, transcript_source}}])`

**Verification:** Querying `lms-lessons` by vector ID confirms 2 vectors stored, semantic similarity working (lumera-u1 query returns itself at score 0.999999, unrelated content at 0.0667).

**Related files:**
- `workers/ai-indexing/src/index.ts` (rewritten for Vectorize)
- `workers/ai-indexing/wrangler.jsonc` (AI + Vectorize bindings)
- `workers/ai-indexing/test/index.test.ts` (mocks updated)

---

## Session: — BLOCKER: Qwen3 Embedding model outputs 1024 dims, not 384

**Symptom:** `VECTOR_UPSERT_ERROR: expected 384 dimensions, got 1024`

**Root cause:** Vectorize index created with `--dimensions 384` (based on earlier assumption from AI Search instance). `@cf/qwen/qwen3-embedding-0.6b` outputs 1024-dim vectors.

**Resolution:** Deleted and recreated `lms-lessons` index with `--dimensions 1024 --metric cosine`. Redeployed worker to pick up new index config.

**Prevention:** Check model docs for actual dimensions before creating Vectorize indexes. Cloudflare's model catalog: https://developers.cloudflare.com/workers-ai/models/

---

## Session: — How does AI indexing work end-to-end? (Chunking, Embedding, Sources)

**Question:** How does the ai-indexing work and how does it embed and store the chunks, and how does it know the sources it uses?

**Answer:**

AI indexing has three layers, only one of which is our code:

### Layer 1: Content Extraction (Our Worker)

The `ai-indexing` worker receives LMS webhooks and fetches video transcripts from Cloudflare Stream:

```
LMS webhook → Worker → Fetch VTT via REST API → Upload JSON to AI Search
```

For **video lessons**: checks captions via Stream binding, fetches VTT via REST API, extracts text with `extractTextFromVTT()`, uploads `{ content, metadata }` JSON to AI Search.

For **text/non-video**: builds a metadata-only string (`"Title. type. Duration: Xs."`) and uploads that.

The VTT fetch requires two secrets (`CLOUDFLARE_STREAM_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`) because the Stream binding has no VTT-content-fetch method — the REST API is the only path.

### Layer 2: AI Search (Cloudflare Managed — we never touch this)

Once we call `instance.items.upload(key, JSON.stringify({ content, metadata }))`, Cloudflare takes over:

1. **Indexing job** scans all uploaded files
2. **Chunks** content into ~512-token pieces (respecting sentence boundaries)
3. **Embeds** each chunk with `@cf/qwen/qwen3-embedding-0.6b` → 384-dimensional vectors
4. **Stores** vectors in Cloudflare's Vectorize database

The instance config: chunk_size=512, chunk_overlap=64, reranking via bge-reranker-base, RRF fusion (keyword + vector combined).

Content is NOT searchable immediately — an indexing job must be triggered (`wrangler ai-search jobs create`) to process the uploaded files.

### Layer 3: How chunks link to sources

Every chunk carries its parent item's full metadata:
```json
{
  "score": 0.6356,
  "text": "{\"content\":\"...\",\"metadata\":{\"title\":\"...\",\"lesson_id\":\"...\",\"course_id\":\"...\",\"org_id\":\"...\"}}",
  "item": { "key": "lesson-lumera-unit1.json" }
}
```

The chunk is never orphaned — it always references back to its source lesson/course/org. The Tutor uses these metadata fields to filter searches (`filter: "lesson_id = X"`).

**Key insights:**
- We never write chunking or embedding code — AI Search does it all
- Content → raw JSON → indexing job → chunks + vectors → searchable
- Three AI Search instances per org (lessons, courses, assessments) for physical multi-tenant isolation
- Chunks carry full metadata back to their source
- Metadata fields (title, lesson_id, course_id, org_id, transcript_source) are all filterable in search queries

**Related files:**
- `workers/ai-indexing/src/index.ts`
- `workers/ai-indexing/code_walkthrough.md`
- `blockers-and-resolutions.md`
- `notes-steps-implementation.md`

---

## Session: — BLOCKER: VTT Fetch Returns 404 (Empty Secrets)

**Symptom:** Video indexing returned `"status":"fallback"` with "Caption generation timed out after 60s"

**Root cause:** `CLOUDFLARE_STREAM_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets were registered in `wrangler secret list` but had **empty values** (len=0). The REST API URL was built as `.../accounts//stream/...` (empty account ID) → 404.

**Resolution:**
1. Created Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens
   - Permission 1: Account → Stream → Read
   - Permission 2: Account → Account Settings → Read
2. Set via `npx wrangler secret put CLOUDFLARE_STREAM_API_TOKEN`
3. Set via `npx wrangler secret put CLOUDFLARE_ACCOUNT_ID` (value: `6a42fe51d00d9ba921124c3f6e7ed092`)
4. Redeployed → immediate fix, VTT fetch returned 815 chars of transcript

**Time spent:** ~90 minutes
**Prevention:** Always verify secrets with a `/env-check` diagnostic endpoint after setting them. `wrangler secret list` can show secrets that exist but have zero-length values.

---

## Session: — BLOCKER: Diagnostic Stub Instead of Pipeline

**Symptom:** All 16 unit tests failed. Worker returned `{tokenLen, acctLen, fetchResult}` instead of `{status:"indexed"}`.

**Root cause:** `src/index.ts` contained a connectivity diagnostic stub that only checked Stream API token lengths. The actual AI01 pipeline was never implemented (or was overwritten during debugging).

**Resolution:** Rewrote the full pipeline from the AI01 spec with all routes, validation, VTT parsing, and both text/video indexing paths. 16/16 tests now pass.

**Time spent:** ~30 minutes
**Prevention:** Run `npx vitest run` before every deploy. The stub was deployed with 0/16 tests passing.

---

## Session: — How to verify AI indexing works end-to-end

**Steps:**
```bash
# 1. Check secrets loaded
curl -s https://ai-indexing.yomi-alarape.workers.dev/env-check

# 2. Index a real video
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -H "Content-Type: application/json" \
  -d '{"event":"publish","org_id":"org-test","entity":{...}}'

# 3. Trigger indexing job
npx wrangler ai-search jobs create org-test-lessons --namespace lms-platform

# 4. Monitor progress
npx wrangler ai-search stats org-test-lessons --namespace lms-platform

# 5. Search
npx wrangler ai-search search org-test-lessons --namespace lms-platform --query "query"
```

Dashboard verification: Workers & Pages → ai-indexing (invocations), AI → AI Search → org-test-lessons (indexed count + search), Stream → video → Captions tab.

---

## Session: — DECISION: REST API for VTT, not Stream Binding

**Context:** The Stream binding (`env.STREAM`) handles captions.list(), captions.generate(), captions.upload(), captions.delete() — but has NO method to read VTT content. We need the actual transcript text.

**Decision:** Use the Cloudflare REST API to fetch VTT: `GET /accounts/{id}/stream/{video}/captions/{lang}/vtt`. This requires `CLOUDFLARE_STREAM_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets.

**Trade-offs:** Gain: reliable VTT access via standard REST API. Lose: two secrets to manage, one extra HTTP call per video index.

---

## Session: — DECISION: Metadata-Only Fallback

**Context:** What happens if caption generation fails (no audio, API error, timeout)?

**Decision:** Upload metadata-only content (`"Title. type. Duration: Xs."`) as fallback instead of failing. The lesson remains findable by title — the Tutor returns degraded results rather than "not found."

**Trade-offs:** Gain: graceful degradation, no broken lessons. Lose: search precision is lower without full transcript.
