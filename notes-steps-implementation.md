# Implementation Log — AI Features for LMS

> Record of everything built, decisions made, and current state.
> Updated after every work session.

---

## Session: Project Scaffold + AI03 LLM Gateway

### Resources provisioned

| Resource | Type | ID |
|----------|------|----|
| `LMS_CACHE` | KV Namespace | `15ec0a3673bd49de87ec203f6a356bde` |
| `indexing-jobs` | Queue | — |
| `lms-platform` | D1 Database | `7b49ccf2-1fe0-46de-88b0-2332b7bbde32` |
| Workers AI | Account-level | Both models available |

### Project scaffolded

```
workers/
├── shared/
│   ├── types.ts              # Shared TS types for all Workers
│   └── fetch-lms.ts          # LMS API client (not yet wired — needs secrets)
├── ai-gateway/               # AI03 ✅ DEPLOYED
├── ai-indexing/              # AI01
├── ai-tutor/                 # AI04
├── ai-insights/              # AI08
├── ai-paths/                 # AI06
├── ai-recommendations/       # AI07
└── ai-dashboard/             # AI13
```

### AI03: LLM Gateway Worker — COMPLETE & DEPLOYED

**What it is:** The single choke point for all LLM calls in the entire AI layer.
Every AI Worker (Tutor, Learning Paths, Insights, Recommendations) calls this
Worker — never calls Workers AI directly. This centralizes model selection,
budget enforcement, and token tracking in one place.

**Endpoint:**
```
POST https://ai-gateway.yomi-alarape.workers.dev/generate
Body: { messages, tier: "standard"|"quality", org_id }
Response: { response, model_used, provider, tokens_used, throttle_warning }
```

**What it does:**
1. Validates request (messages, tier, org_id)
2. Checks org budget in D1 → 429 if exhausted
3. Picks model by tier:
   - `standard` → `@cf/meta/llama-3.2-3b-instruct`
   - `quality` → `@cf/mistral/mistral-7b-instruct-v0.2-lora`
4. Calls Workers AI
5. Tracks token usage in D1 (increments `tokens_used_this_period`)
6. Returns standardized response with throttle warning if near cap

**Bindings:** AI (Workers AI), DB (D1 `lms-platform`), LMS_CACHE (KV)

**D1 schema:**
```sql
CREATE TABLE org_budgets (
  org_id TEXT PRIMARY KEY,
  monthly_token_cap INTEGER DEFAULT 1000000,
  tokens_used_this_period INTEGER DEFAULT 0,
  billing_period_start INTEGER
);
```

**Test org seeded:** `org-test` (100k token cap, 0 used)

**Tests:** 14/14 passing
- Validation (6): method, path, JSON, messages, tier, org_id
- Budget (2): exhausted → 429, remaining → passes
- Tier routing (2): standard → llama, quality → mistral
- Token tracking (2): response count, D1 increment
- Throttle (2): near-cap warning, under-cap no warning

**Test setup:** Uses `wrangler.test.jsonc` (no `ai` binding — Workers AI only runs on edge).
Mock injected via `env.AI = { run: vi.fn() }` for local vitest runs.

**Deployed at:** `https://ai-gateway.yomi-alarape.workers.dev`

---

## Architecture Decision Log

### Model name: Mistral changed from spec
- Spec says: `@cf/mistral/mistral-7b-instruct-v0.2`
- Available: `@cf/mistral/mistral-7b-instruct-v0.2-lora`
- The base model was deprecated; Cloudflare replaced it with the LoRA variant.
  Same API, just a different model ID.

### AI binding can't run locally
- Workers AI (`env.AI.run()`) only works on Cloudflare's edge
- Local vitest needs a separate `wrangler.test.jsonc` without the `ai` binding
- Tests mock `env.AI.run()` — we test the Worker's logic, not Cloudflare's inference
- For real AI calls during development: `wrangler dev` uses the real binding remotely

### AI03 doesn't need LMS access
- The spec listed "LMS internal key" as a blocker, but AI03 only calls Workers AI
- `LMS_GATEWAY_URL` and `LMS_INTERNAL_KEY` are only needed when the Tutor calls LMS
- Removed from AI03's blocker list

### Direct Vectorize over AI Search (beta bug)
- AI Search beta failed to persist vectors across 5+ attempts
- Decision: bypass AI Search entirely — embed with Workers AI, upsert directly to Vectorize
- index: `lms-lessons`, 1024-dim, cosine metric

---

## Session: AI01 Content Indexing Pipeline

### WHAT WAS FIXED: The Diagnostic Stub

The deployed worker had a diagnostic stub instead of the real indexing logic.
It only checked token lengths and returned a VTT preview — no routing, no
validation, no Vectorize integration. All 16 unit tests failed.

**Before (diagnostic stub):**
```typescript
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const tokenLen = (env.CLOUDFLARE_STREAM_API_TOKEN || '').length;
    const acctLen = (env.CLOUDFLARE_ACCOUNT_ID || '').length;
    return Response.json({ tokenLen, acctLen, vttUrl, fetchResult });
  }
};
```

**After (full pipeline):** ~280 lines implementing all AI01 routes.

### What was implemented

| Route | Purpose |
|-------|---------|
| `POST /index` | Accepts publish events, handles text (metadata upload) and video (caption extraction) |
| `POST /deindex` | Accepts unpublish events, deletes from Vectorize |
| `POST /backfill` | Lists Stream videos, counts ready vs processing |
| `GET /videos` | Diagnostic: list all Stream videos |
| `GET /captions/:id` | Diagnostic: check caption status + VTT content |

### Video Pipeline

```
1. Check streamStatus === "ready" → if not, return 202 queued
2. Check captions via STREAM binding → captions.list()
3a. Captions exist → fetch VTT via REST API → extract text
3b. No captions → generate via AI → poll until ready → fetch VTT
4. Embed content (1024-dim) + upsert to Vectorize
5. Fallback: if captioning fails → upload metadata-only
```

### VTT Fetch Blocker

The Stream binding (`env.STREAM`) handles captions list/generate/delete,
but has **no method to fetch VTT content**. That requires the REST API:

```
GET https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/stream/{VIDEO_ID}/captions/en/vtt
Authorization: Bearer {API_TOKEN}
```

Two secrets were registered but EMPTY in the deployed worker:
- `CLOUDFLARE_STREAM_API_TOKEN` → len=0
- `CLOUDFLARE_ACCOUNT_ID` → len=0

**Fix:** Created a Cloudflare API token with `Stream:Read` + `Account Settings:Read`,
set both via `wrangler secret put`. See `blockers-and-resolutions.md`.

### Live end-to-end test

```bash
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -d '{"event":"publish","org_id":"org-test","entity":{
    "id":"lesson-lumera-unit1","title":"Lumera Unit 1",
    "contentType":"video","cloudflareVideoId":"69a58083...",
    "streamStatus":"ready","durationSeconds":57}}'

# Response: {"status":"indexed","transcript_source":"existing","content_length":815}
```

✅ VTT fetched from Cloudflare Stream API
✅ 815 chars of transcript extracted from WebVTT
✅ Embedded + upserted to Vectorize

### Tests: 16/16 passing

### Deployed

- URL: `https://ai-indexing.yomi-alarape.workers.dev`
- Bindings: AI, STREAM, VECTORIZE_INDEX, INDEXING_QUEUE
- Secrets: CLOUDFLARE_STREAM_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

---

## Current Project State

| Slice | Status | Notes |
|-------|--------|-------|
| AI03 LLM Gateway | ✅ DONE | Deployed, tested, 14/14 tests pass |
| AI01 Content Indexing | ✅ DONE | Deployed, tested, 16/16 tests pass, live VTT fetch working |
| AI04 Tutor | ✅ DONE | Deployed, tested, 15/15 tests pass, grounded answers with citations |
| AI08 Post-Quiz Insights | ⬜ pending | Needs LMS_GATEWAY_URL, LMS_INTERNAL_KEY |
| AI06 Learning Paths | ⬜ pending | Needs LMS_GATEWAY_URL, LMS_INTERNAL_KEY |
| AI07 Recommendations | ⬜ pending | Needs LMS_GATEWAY_URL, LMS_INTERNAL_KEY |
| AI13 Demo Dashboard | ⬜ ongoing | One card added per slice |
| F01 CV Parsing | ⬜ Phase 2 | Depends on AI05 |
| F02 Mentor Matching | ⬜ Phase 2 | Depends on AI05 |
| F03 Skill-Gap Analysis | ⬜ Phase 2 | Depends on AI05, P07, P08 |
| F04 Org Plan Tuning | ⬜ Phase 3 | Depends on AI06, P07, P08 |
| F05 Admin Analytics | ⬜ Phase 3 | Depends on P07, P08, F04 |

### Vectorize Architecture (replaced AI Search)

Content flows: Stream VTT → extract text → Workers AI embed (1024-dim qwen3) → Vectorize upsert.
No AI Search dependency. Embeddings stored in `lms-lessons` index (cosine metric, metadata-indexed fields: lesson_id, org_id, course_id, module_id).

### How the Tutor finds content

The learner is already inside a specific lesson when they ask. The Tutor embeds the question, queries Vectorize, and post-filters by `lesson_id` + `org_id`:

```
Learner watching "Python - Lesson 3: Variables"
→ Asks "what's the difference between int and float?"
→ Tutor embeds question → queries Vectorize → filters by lesson_id
→ Returns chunks from THAT lesson's content
→ If nothing found, expands scope: lesson → module → course
```

### LMS Integration Markers

Three `LMS_INTEGRATION` markers in the codebase (search to find them):
1. `ai-indexing/src/index.ts` — webhook signature verification (needs `LMS_WEBHOOK_SECRET`)
2. `ai-indexing/src/index.ts` — LMS API metadata enrichment (needs `LMS_GATEWAY_URL` + `LMS_INTERNAL_KEY`)
3. `ai-tutor/src/index.ts` — LMS API lesson metadata for citations (needs `LMS_GATEWAY_URL` + `LMS_INTERNAL_KEY`)
