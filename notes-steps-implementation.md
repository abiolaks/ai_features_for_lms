# Implementation Log — AI Features for LMS

> Chronological record of everything built, decisions made, and current state.
> Updated after every work session.

---

## July 1, 2026 — Project Scaffold + AI03 LLM Gateway

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
├── ai-indexing/              # AI01 (Week 2)
├── ai-tutor/                 # AI04 (Week 3)
├── ai-insights/              # AI08 (Week 3)
├── ai-paths/                 # AI06 (Week 4)
├── ai-recommendations/       # AI07 (Week 5)
└── ai-dashboard/             # AI13 (ongoing)
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
**Version:** `7a5442d0-a25a-411e-9b9e-00bdf2140fa9`

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
- `LMS_GATEWAY_URL` and `LMS_INTERNAL_KEY` are only needed starting Week 3 (AI04 Tutor)
- Removed from AI03's blocker list

### Secrets not yet set
- `LMS_GATEWAY_URL` — needed by AI04+ to call the LMS API
- `LMS_INTERNAL_KEY` — needed by AI04+ for auth
- `CLOUDFLARE_API_TOKEN` — needed by AI01 for Stream captioning
- `CLOUDFLARE_ACCOUNT_ID` — needed by AI01 for Stream API
- `LMS_WEBHOOK_SECRET` — needed by AI01 for webhook verification
- None are needed for AI03. All can wait until their respective Workers.

---

## Current Project State

| Slice | Status | Week | Notes |
|-------|--------|------|-------|
| AI03 LLM Gateway | ✅ DONE | 1 | Deployed, tested, 14/14 tests pass |
| AI01 Content Indexing | ⬜ pending | 2 | Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID |
| AI04 Tutor | ⬜ pending | 3 | Blocked by AI01 (needs indexed content) |
| AI08 Post-Quiz Insights | ⬜ pending | 3 | Needs LMS_GATEWAY_URL, LMS_INTERNAL_KEY |
| AI06 Learning Paths | ⬜ pending | 4 | Needs LMS_GATEWAY_URL, LMS_INTERNAL_KEY |
| AI07 Recommendations | ⬜ pending | 5 | Needs LMS_GATEWAY_URL, LMS_INTERNAL_KEY |
| AI13 Demo Dashboard | ⬜ ongoing | 1–5 | One card added per slice |

### AI Search Instances — Why three per org?

AI Search is Cloudflare's managed search engine. It handles chunking, embedding,
and ranking automatically. Each instance is a separate search index:

| Instance | Stores | Used by |
|----------|--------|---------|
| `org-{id}-lessons` | Video transcripts, lesson text | AI04 Tutor — "find lesson content about variables" |
| `org-{id}-courses` | Course titles, descriptions | AI06 Paths — "which courses cover ML?" |
| `org-{id}-assessments` | Quiz questions, rubrics | AI08 Insights — "find quiz questions about functions" |

**Why separate?** Searching "variables" in lessons returns transcripts.
Searching "variables" in assessments returns quiz questions. Different use cases,
different indexes. The Tutor searches only lessons so results are clean.

**Multi-tenant isolation:** `org-test-lessons` is a physically separate instance
from `org-acme-lessons`. The binding `env.AI_SEARCH.get("org-test-lessons")`
can never return org-acme's data.

### How does the AI Tutor know which lesson to answer from?

The learner is already inside a specific lesson when they ask. The request includes
`lesson_id`, so the Tutor searches ONLY that lesson's transcript in AI Search:

```
Learner watching "Python - Lesson 3: Variables"
→ Asks "what's the difference between int and float?"
→ Tutor searches AI Search with filter: lesson_id = "lesson-123"
→ Returns chunks from THAT lesson's transcript only
→ If nothing found, expands scope: lesson → module → course
```

The scope ladder:

| Scope | Filter | Trigger |
|-------|--------|---------|
| Lesson | `lesson_id = X` | Default — first attempt |
| Module | `module_id = Y` | If lesson returns no chunks |
| Course | `course_id = Z` | If module returns no chunks |

This means the answer is always grounded in real transcript text — the prompt
forces the LLM to "use ONLY the provided content" and say "I couldn't find that"
if the answer isn't there. No hallucinations from thin air.

### Next up: AI01 Content Indexing
Blocked by: AI Search instances (org-test-lessons, org-test-courses, org-test-assessments)
Also needs: test video in Cloudflare Stream, LMS_WEBHOOK_SECRET, STREAM binding
No longer needed: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (Stream binding handles auth)
