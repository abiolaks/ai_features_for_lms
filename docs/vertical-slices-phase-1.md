# AI Features MVP — Vertical Slices

> LMS platform is already built. AI layer is Cloudflare Workers calling Huawei Qwen3.6.
> Each slice = one deployable Worker = one PR (200-400 lines).

---

## Architecture Reality

```
LMS (ALREADY BUILT)              AI Workers (TO BUILD)            LLM
─────────────────────            ─────────────────────            ───
/v1/lessons/{id}    ←── AI01 Indexing (chunk + embed + index)
/v1/catalog         ←── AI02 RAG Retrieval (vector search)
/v1/learner/profile ←── AI03 LLM Gateway ───────────────────→ Huawei Qwen3.6
/v1/progress/user   ←── AI04 Tutor (grounded Q&A)
/v1/assessments/{id}←── AI06 Learning Paths
/v1/courses/recommendations ←── AI07 Enhanced Recommendations
                             AI08 Post-Quiz Insights
```

**All AI Workers read from LMS via `GET /api/v1/...` with `LMS_INTERNAL_KEY`.**
**AI03 is the only Worker that calls Huawei. All others call AI03 via Service Binding.**

---

## Observability Is Woven In — Not a Separate Phase

Every slice includes its own instrumentation. No separate "add tracing later" step.

| When | What Gets Instrumented | How |
|------|----------------------|-----|
| **Week 0** (setup) | Enable Workers auto-tracing in `wrangler.toml` | 3 lines per Worker |
| **Every slice** | Manual LLM spans (model, tokens, latency, org_id) | `tracer.startActiveSpan()` — ~15 lines |
| **Week 3** (after Tutor ships) | Start Phoenix locally, export traces | Docker + OTLP destination |
| **Week 4** (after Tutor + Insights ship) | Run first evals (groundedness, relevance, tone) | Python script against Phoenix |
| **Week 5** | Add health metrics cards to AI13 dashboard | Workers API calls |

---

## Slice Map — 8 Workers, 5 Weeks

| # | Slice | Worker | PR Size | Week | Observability |
|---|-------|--------|---------|------|---------------|
| 0 | — | **Tracing foundation** (wrangler.toml) | ~5 lines | 0 | Auto-tracing enabled |
| 1 | AI03 | LLM Gateway | ~300 | 1 | LLM spans + budget metrics |
| 2 | AI01 | Content Indexing | ~350 | 2 | Embedding spans + Vectorize traces |
| 3 | AI02 | RAG Retrieval | ~150 | 2 | Retrieval spans (query, results, scores) |
| 4 | AI04 | Tutor | ~300 | 3 | Full trace: LMS→Vectorize→Huawei→response |
| 5 | AI08 | Post-Quiz Insights | ~200 | 3 | Tone checks + review-link validity |
| — | — | **Phoenix + first evals** | ~50 | 3-4 | Groundedness, relevance, tone scores |
| 6 | AI06 | Learning Paths | ~300 | 4 | Path ordering validation spans |
| 7 | AI07 | Enhanced Recs | ~200 | 5 | Cache metrics + fallback cascade traces |
| 8 | AI13 | Demo Dashboard | ~200 | 1-5 | Health card added each week |

---

---

## Week 0: Tracing Foundation (Before Any Slice)

**Setup once, applies to all Workers.**

### wrangler.toml — Every Worker gets this

```toml
[observability.traces]
enabled = true
head_sampling_rate = 1.0    # 100% in dev, 0.05 in prod
```

### Shared instrumentation helper (lib/tracing.ts)

```typescript
import { trace, Span } from '@opentelemetry/api';

const tracer = trace.getTracer('ai-workers');

export function startLLMSpan(name: string, attrs: Record<string, unknown>): Span {
  const span = tracer.startSpan(name);
  span.setAttributes(attrs);
  return span;
}

export function recordLLMResult(span: Span, result: {
  response: string;
  model: string;
  tokens: number;
  latencyMs: number;
}) {
  span.setAttributes({
    'llm.output': result.response,
    'llm.model': result.model,
    'llm.token_count': result.tokens,
    'llm.latency_ms': result.latencyMs,
  });
  span.end();
}
```

**Acceptance criteria:**
- [ ] `wrangler.toml` has `[observability.traces] enabled = true`
- [ ] `lib/tracing.ts` created with `startLLMSpan` and `recordLLMResult`
- [ ] Deploy any Worker → traces visible in Cloudflare Dashboard → Observability

---

## Slice 1: AI03 — LLM Gateway Worker

- **Type:** AFK
- **Week:** 1
- **Depends on:** Huawei API key, LMS internal key

### What to build

The single entry point for all LLM calls. Every AI Worker calls this — never Huawei directly.

```
POST /generate
  body: { messages, tier: "standard"|"quality", org_id }
  response: { response, model_used, provider: "huawei", tokens_used }
```

**Behavior:**
1. Check org budget in D1 → reject if exhausted (429)
2. Route to Huawei ModelArts: `qwen3.6-flash` (standard) or `qwen3.6-27b` (quality)
3. If Huawei fails → fallback to Cloudflare Workers AI (Llama 3.2 / Mistral)
4. Track token usage in D1
5. Return standardized response

**D1 schema (only table needed for MVP):**
```sql
CREATE TABLE org_budgets (
  org_id TEXT PRIMARY KEY,
  monthly_token_cap INTEGER DEFAULT 1000000,
  tokens_used_this_period INTEGER DEFAULT 0,
  billing_period_start INTEGER
);
```

### Acceptance criteria
- [ ] `POST /generate` with valid org → routes to Huawei, returns AI response + token count
- [ ] Budget exhausted → returns 429 with message
- [ ] Huawei unavailable → auto-fallback to Cloudflare Workers AI
- [ ] Token tracking: 5 calls → D1 shows correct cumulative usage
- [ ] `wrangler dev` works with Cloudflare Tunnel to LMS
- [ ] **Observability:** Huawei `fetch()` spans auto-traced (latency, status) in CF Dashboard
- [ ] **Observability:** Manual LLM spans include model name, tier, tokens, org_id
- [ ] **Observability:** Budget exhaustion → 429 visible in trace with `error: true`

---

## Slice 2: AI01 — Content Indexing Pipeline

- **Type:** AFK
- **Week:** 2
- **Depends on:** AI03 (for token counting via tiktoken), LMS `/v1/lessons/{id}`

### What to build

Reads lesson content from LMS, chunks it, embeds with bge-m3, indexes into Vectorize.

```
POST /index
  body: { lesson_id, course_id, module_id, org_id }
```

**Pipeline:**
1. `GET /api/v1/lessons/{lesson_id}` from LMS → lesson.content
2. Chunk into ~512-token segments (tiktoken WASM)
3. Embed each chunk via Workers AI `bge-m3` (1024-dim)
4. Upsert to Vectorize with full metadata: `{ org_id, course_id, module_id, lesson_id, lesson_title, section_heading, chunk_index, text }`

```
POST /deindex
  body: { lesson_id, org_id }
→ removes all chunks for that lesson from Vectorize
```

### Acceptance criteria
- [ ] Index a real lesson from LMS → chunks appear in Vectorize with correct metadata
- [ ] Query Vectorize for lesson content → returns relevant chunks
- [ ] Re-index same lesson → stale chunks replaced
- [ ] De-index → chunks removed within 60 seconds
- [ ] Chunks are ~512 tokens ±15%
- [ ] Each chunk carries: org_id, course_id, lesson_id, section_heading, chunk_index
- [ ] `wrangler dev` with Cloudflare Tunnel to LMS → index a lesson → verify in Vectorize dashboard
- [ ] **Observability:** Embedding spans show model (bge-m3), chunk count, vector dimensions
- [ ] **Observability:** Vectorize upsert spans auto-traced (count, latency)
- [ ] **Observability:** LMS fetch spans auto-traced (lesson content size, latency)

---

## Slice 3: AI02 — RAG Retrieval Engine

- **Type:** AFK
- **Week:** 2
- **Depends on:** AI01 (Vectorize must have data)

### What to build

Embeds a query, searches Vectorize, returns relevant chunks.

```
POST /retrieve
  body: { query, org_id, scope: { type: "lesson"|"module"|"course", id: "..." } }
  response: { chunks: [{ text, citation: { lesson_title, section_heading }, score }] }
```

**Behavior:**
1. Embed query via Workers AI `bge-m3`
2. Query Vectorize with filter: `{ org_id, [scope_type]_id }`
3. Return chunks above relevance threshold
4. If no chunks meet threshold → return empty (never fabricate)

### Acceptance criteria
- [ ] Query about indexed content → returns relevant chunks with scores
- [ ] Query about unrelated topic → returns empty
- [ ] Scope filtering works: lesson scope returns only that lesson's chunks
- [ ] Module scope returns chunks from all lessons in that module
- [ ] Org isolation: org-1 query never returns org-2 chunks
- [ ] **Observability:** Retrieval spans include query text, result count, top-3 scores
- [ ] **Observability:** Empty result spans marked with `retrieval.empty: true`

---

## Slice 4: AI04 — Tutor

- **Type:** AFK
- **Week:** 3
- **Depends on:** AI02 (RAG), AI03 (LLM Gateway), LMS `/v1/lessons/{id}`

### What to build

Grounded Q&A — learner asks a question, AI answers with citations from lesson content.

```
POST /tutor/ask
  body: { question, lesson_id, course_id, org_id }
  response: { answer, citations: [{ lesson_title, section_heading, excerpt }] }
```

**Behavior:**
1. Get lesson structure from LMS for citation building: `GET /api/v1/lessons/{lesson_id}`
2. Retrieve relevant chunks via AI02 with `lesson` scope
3. Build grounded prompt: "Answer using ONLY the provided content. Cite the section heading."
4. Call AI03 (tier=standard) → generate answer
5. If no chunks found → respond: "I couldn't find that in this lesson. Try expanding scope?"
6. Scope expansion: follow-up with `expand_scope: true` → retrieves from module/course scope

### Acceptance criteria
- [ ] Ask question about lesson content → cited answer with section heading + excerpt
- [ ] Ask question not in lesson → "not found" with scope expansion suggestion
- [ ] Expand scope to module → wider retrieval, answer returned
- [ ] Answer is grounded (prompt enforces "use ONLY provided content")
- [ ] Integration: index lesson via AI01 → query via AI02 → ask via AI04 → get cited answer
- [ ] **Observability:** Full trace shows: fetch LMS → Vectorize query → fetch Huawei → response
- [ ] **Observability:** LLM span includes prompt, response, model, tokens, latency
- [ ] **Observability:** `scope_expansion` flag captured, citations count (`citations.count: N`)

---

## Slice 5: AI08 — Post-Quiz Insights

- **Type:** AFK
- **Week:** 3
- **Depends on:** AI03, LMS `/v1/learner/assessments/{id}`, LMS `/v1/progress/user`, LMS `/v1/lessons/{id}`

### What to build

After a learner finishes a quiz, generate a personalized coaching insight.

```
POST /insights/generate
  body: { assessment_id, learner_id, org_id }
  response: { insight_text, missed_topics: [{ topic, review_link }] }
```

**Behavior:**
1. Get assessment results from LMS: `GET /api/v1/learner/assessments/{assessment_id}`
2. Get course progress for context: `GET /api/v1/progress/user`
3. Get lesson sections for review links: `GET /api/v1/lessons/{lesson_id}`
4. Build prompt with: score, correct/incorrect breakdown, per-question timing, course progress
5. Call AI03 (tier=standard) → generate encouraging insight
6. Attach review links to specific lesson sections for missed topics

**Prompt rules:** "Be encouraging. Never shaming. If score < 50%, emphasize what they got right first."

### Acceptance criteria
- [ ] Submit a quiz → AI generates insight with topic-specific review links
- [ ] Insight references course progress ("you're 65% through — right on track")
- [ ] Insight references time-per-question ("you spent longer on loops — review suggested")
- [ ] Tone is encouraging regardless of score (0% or 100%)
- [ ] All review links are valid LMS URLs
- [ ] AI03 unavailable → returns placeholder: "Insights unavailable right now"
- [ ] **Observability:** Insight span includes score, question count, missed topics
- [ ] **Observability:** Review links validated (no 404s) — captured as span attribute
- [ ] **Observability:** Tone check flag (`tone.encouraging: true`) captured

---

## Slice 6: AI06 — Learning Paths

- **Type:** AFK
- **Week:** 4
- **Depends on:** AI03, LMS `/v1/catalog`, LMS `/v1/learner/profile`, LMS `/v1/progress/user`

### What to build

Generate an AI-personalized learning path based on learner profile, progress, and course catalogue.

```
POST /paths/generate
  body: { learner_id, org_id }
  response: { path: [{ course_title, order, why_this_fits }] }
```

**Behavior:**
1. Get learner profile: `GET /api/v1/learner/profile` → skills, gamification, stats
2. Get catalogue: `GET /api/v1/catalog` → all published courses
3. Get progress: `GET /api/v1/progress/user` → completed + in-progress
4. Build prompt: "Here are N courses. Learner has these skills, these goals, this experience level. Order them into a logical learning path. Prerequisites must come first."
5. Call AI03 (tier=standard) → generate path with `why_this_fits` per course
6. Filter out already-completed courses

### Acceptance criteria
- [ ] Generate path from real learner profile + real catalogue → ordered course list
- [ ] Each course has a `why_this_fits` explanation
- [ ] Already-completed courses excluded from path
- [ ] Prerequisites come before dependents in order
- [ ] Minimal profile (no skills, no goals) → returns catalogue browse view with message
- [ ] AI03 unavailable → returns course list without explanations, `ai_status: "degraded"`
- [ ] **Observability:** Path span includes course count, prerequisite violations (0 expected)
- [ ] **Observability:** LMS calls (profile, catalogue, progress) all traced

---

## Slice 7: AI07 — Enhanced Recommendations

- **Type:** AFK
- **Week:** 5
- **Depends on:** AI03, LMS `/v1/courses/recommendations`, LMS `/v1/catalog`, LMS `/v1/learner/profile`, LMS `/v1/progress/user`

### What to build

Enhance the LMS's existing recommendations with AI-generated "why this fits" explanations.

```
GET /recommendations/dashboard?learner_id={id}&org_id={org}
  response: { recommendations: [{ course_title, lms_reason, ai_why_this_fits }] }
```

**Behavior:**
1. Get LMS baseline recommendations: `GET /api/v1/courses/recommendations`
2. Get learner profile + progress for personalization context
3. Get catalogue for course details
4. For each LMS recommendation, call AI03 to generate `ai_why_this_fits`
5. Merge into response: LMS recommends what → AI explains why
6. Cache result in KV (24h TTL)

### Acceptance criteria
- [ ] Returns recommendations where each has both LMS reason + AI explanation
- [ ] AI explanations reference learner's actual skills, progress, goals
- [ ] Results cached in KV → second call within 24h returns instantly
- [ ] LMS recommendations unavailable → AI generates recs from catalogue alone
- [ ] AI03 unavailable → returns LMS recs without explanations, `ai_status: "degraded"`
- [ ] **Observability:** KV cache span shows `cache.hit: true/false`
- [ ] **Observability:** Fallback cascade visible in trace (LMS recs → AI03 → KV cache)
- [ ] **Observability:** Degraded response marked with `ai_status: "degraded"` in span

---

## Slice 8: AI13 — Demo Dashboard

- **Type:** AFK
- **Week:** 1-5 (cumulative)
- **Depends on:** All other slices (built incrementally)

### What to build

A single-page dashboard that proves every AI feature works. Built incrementally — each slice adds its card.

**Week 1:** Shell with AI03 card (budget status, model health)  
**Week 2:** Add AI01+AI02 card (indexing status, retrieval test)  
**Week 3:** Add AI04 (tutor demo) + AI08 (insights demo) cards  
**Week 4:** Add AI06 (paths demo) card  
**Week 5:** Add AI07 (recs demo) card + polish

### Acceptance criteria
- [ ] Dashboard loads at deployed URL
- [ ] Each slice adds its card without breaking existing cards
- [ ] Cards show real data from LMS + AI Workers (not mock)
- [ ] Progress tracker shows overall completion
- [ ] **Observability:** Health metrics cards added weekly (groundedness, latency, budget)
- [ ] **Observability:** Each card shows degraded state when Worker is unreachable

---

## What Was Cut

| Old Slice | Reason |
|-----------|--------|
| AI05 Learner Profile | LMS already has richer profiles via `/v1/learner/profile` |
| AI10a Question Gen | Post-MVP — complex prompt engineering, needs quality tier |
| AI10b Approval Workflow | Post-MVP — LMS admin dashboard handles this |
| AI11 Quality Checks | Post-MVP — no learner-visible impact |
| AI04b Tutor History | Post-MVP — MVP is stateless Q&A |
| AI09 Platform Assistant | Post-MVP — stretch goal |
| AI12 Fail Gracefully | Implicit in each Worker (health checks + fallback) |

## PR Rules

- **One Worker per PR** (200-400 lines including tests + instrumentation)
- **Must include observability** — LLM spans for AI03 calls, relevant span attributes
- **Must work with real LMS data** — no mock endpoints
- **`wrangler dev` must pass** before PR
- **Traces must be visible** in Cloudflare Dashboard after deploy
- **Add dashboard card** to AI13 in the same PR
- **Test with Cloudflare Tunnel** to local LMS Gateway

## Local Development

```bash
# Terminal 1: LMS platform
docker compose up

# Terminal 2: Tunnel (expose LMS to Workers)
cloudflared tunnel --url http://localhost:8000
# → https://lms-dev-xyz.trycloudflare.com

# Terminal 3: AI Worker dev
cd workers/ai-gateway
LMS_GATEWAY_URL=https://lms-dev-xyz.trycloudflare.com wrangler dev
```
