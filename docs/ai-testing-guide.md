# AI Worker Testing Guide

> How to test each AI feature during development. Real LMS, real traces, real confidence.

---

## Testing Philosophy

**No mocks for LMS data.** Workers must be tested against the real LMS API (via Cloudflare Tunnel). The only acceptable mock is Workers AI embeddings (mock with known vectors).

```
✅ Test against real LMS      — actual api.json endpoints via tunnel
✅ Test against real CF infra  — Vectorize, D1, KV (wrangler dev)
⚠️ Mock Workers AI LLM           — recorded responses for deterministic tests
⚠️ Mock bge-m3 embeddings      — known vectors for reproducible retrieval
❌ Never mock LMS data          — defeats the purpose of integration
```

---

## Per-Slice Testing

### AI03 — LLM Gateway

**What to test:**
```
1. Budget enforcement
   - Budget NOT exhausted → POST /generate returns 200
   - Budget exhausted → returns 429 { error: "budget_exhausted" }
   - 5 calls → D1 shows cumulative tokens

2. Provider routing
   - tier=standard → calls Llama 3.2
   - tier=quality → calls Mistral

3. Fallback
   - Mock Workers AI as down → Worker returns 502 with degraded status
   - Response still returns valid { response, tokens_used }
```

**How to test during dev:**
```bash
# Terminal 1: Run worker locally
cd workers/ai-gateway
npx wrangler dev

# Terminal 2: Test against it
# Test 1: Basic generation
curl -X POST http://localhost:8787/generate \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello"}],"tier":"standard","org_id":"test-org"}'
# Expect: { response: "Hello!", model_used: "@cf/meta/llama-3.2-3b-instruct", tokens_used: 10 }

# Test 2: Quality tier
curl -X POST http://localhost:8787/generate \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Explain quantum computing"}],"tier":"quality","org_id":"test-org"}'
# Expect: model_used: "@cf/mistral/mistral-7b-instruct-v0.2"

# Test 3: Budget exhaustion (after setting cap to 50 tokens in D1)
# Expect: 429 { error: "budget_exhausted" }
```

**Vitest unit tests:**
```typescript
// ai-gateway/test/index.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('AI03 LLM Gateway', () => {
  it('returns 429 when budget exhausted', async () => {
    // Seed D1 with exhausted budget
    await env.DB.prepare(
      'UPDATE org_budgets SET tokens_used_this_period = 1000000 WHERE org_id = ?'
    ).bind('test-org').run();

    const res = await worker.fetch(new Request('http://localhost/generate', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], tier: 'standard', org_id: 'test-org' }),
    }));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('budget_exhausted');
  });

  it('returns degraded when Workers AI fails', async () => {
    // Mock Workers AI as failing
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));

    const res = await worker.fetch(/* ... */);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('cloudflare'); // Fell back
  });
});
```

---

### AI01 — Content Indexing

**What to test:**
```
1. Chunking
   - 1000-word lesson → 2+ chunks
   - Each chunk ~512 tokens ±15%
   - Adjacent chunks share overlap

2. Indexing pipeline
   - POST /index → fetches from LMS → chunks → embeds → Vectorize
   - Re-index → stale chunks replaced
   - POST /deindex → chunks removed

3. Metadata
   - Each Vectorize entry has: org_id, course_id, lesson_id, section_heading, chunk_index
```

**How to test during dev:**
```bash
# 1. Ensure LMS is running and reachable
curl http://localhost:8000/api/v1/lessons/some-lesson-id
# Expect: { success: true, data: { id: "...", title: "...", content: "..." } }

# 2. Index a lesson
curl -X POST http://localhost:8787/index \
  -H "Content-Type: application/json" \
  -d '{"lesson_id":"some-lesson-id","course_id":"python-101","module_id":"mod-1","org_id":"org-1"}'
# Expect: { indexed: true, chunks: 12 }

# 3. Verify in Cloudflare Dashboard → Vectorize → your-index
# Should show 12 vectors with correct metadata

# 4. De-index
curl -X POST http://localhost:8787/deindex \
  -H "Content-Type: application/json" \
  -d '{"lesson_id":"some-lesson-id","org_id":"org-1"}'
# Expect: { deindexed: true }

# 5. Verify 0 vectors remaining
```

---

### AI02 — RAG Retrieval

**What to test:**
```
1. Relevant retrieval
   - Query about indexed content → returns chunks with scores > 0.7
   - Each chunk has citation metadata

2. Irrelevant queries
   - Query about unrelated topic → returns { chunks: [] }

3. Scope filtering
   - lesson scope → only that lesson's chunks
   - module scope → all lessons in module
   - course scope → all modules in course

4. Org isolation
   - org-1 query with org-2 data → never returns org-2 chunks
```

**How to test during dev:**
```bash
# After indexing a Python lesson:
curl -X POST http://localhost:8787/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query":"How do I define a function?","org_id":"org-1","scope":{"type":"lesson","id":"some-lesson-id"}}'
# Expect: { chunks: [{ text: "To define a function...", citation: {...}, score: 0.92 }, ...] }

# Test empty result:
curl -X POST http://localhost:8787/retrieve \
  -H "Content-Type: application/json" \
  -d '{"query":"How do I bake a cake?","org_id":"org-1","scope":{"type":"lesson","id":"some-lesson-id"}}'
# Expect: { chunks: [] }
```

---

### AI04 — Tutor

**What to test:**
```
1. Grounded answer
   - Ask question about lesson → answer with citations
   - Citations include section_heading and excerpt

2. Not found
   - Ask question not in lesson → "I couldn't find that" + scope_expansion_suggested

3. Scope expansion
   - Follow-up with expand_scope: "module" → wider retrieval → answer returned

4. No chunks at all
   - AI02 returns empty → Tutor returns "not found" without calling AI03
```

**How to test during dev:**
```bash
# 1. Index a lesson first (AI01)
curl -X POST http://localhost:8787/index -d '{"lesson_id":"python-functions",...}'

# 2. Ask a question
curl -X POST http://localhost:8787/tutor/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What is a decorator?","lesson_id":"python-functions","course_id":"python-101","org_id":"org-1"}'
# Expect: { answer: "A decorator is...", citations: [{ lesson_title: "Python Functions", section_heading: "Advanced Functions", excerpt: "..." }] }

# 3. Ask something not in the lesson
curl -X POST http://localhost:8787/tutor/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I deploy to Kubernetes?","lesson_id":"python-functions","course_id":"python-101","org_id":"org-1"}'
# Expect: { answer: "I couldn't find that in this lesson.", scope_expansion_suggested: true, citations: [] }
```

---

### AI08 — Post-Quiz Insights

**What to test:**
```
1. Insight generation
   - Submit quiz with mixed results → insight identifies weak areas
   - Review links point to real LMS lesson sections

2. Tone
   - Score 0% → still encouraging, never shaming
   - Score 50% → balanced, constructive
   - Score 100% → congratulatory

3. Course progress context
   - Insight references current progress % from LMS

4. Degradation
   - AI03 down → returns placeholder message
```

**How to test during dev:**
```bash
# 1. Ensure LMS has an assessment with results
curl http://localhost:8000/api/v1/learner/assessments/some-assessment-id
# Expect assessment data with questions, answers, scores

# 2. Generate insight
curl -X POST http://localhost:8787/insights/generate \
  -H "Content-Type: application/json" \
  -d '{"assessment_id":"some-assessment-id","learner_id":"learner-1","org_id":"org-1"}'
# Expect: { insight_text: "You scored 75%...", missed_topics: [{ topic: "Decorators", review_link: "/courses/python-101/lessons/functions#advanced" }], tone_check: "encouraging" }

# 3. Verify review links work
curl http://localhost:8000/api/v1/lessons/functions
# Expect: 200 with sections matching the review link slugs
```

---

### AI06 — Learning Paths

**What to test:**
```
1. Path generation
   - Real learner profile + real catalogue → ordered course list
   - Each course has why_this_fits explanation

2. Prerequisites
   - No course appears before its prerequisite
   - Completed courses excluded

3. Edge cases
   - Minimal profile → returns catalogue view with message
   - AI03 down → returns list without explanations
```

**How to test during dev:**
```bash
curl -X POST http://localhost:8787/paths/generate \
  -H "Content-Type: application/json" \
  -d '{"learner_id":"learner-1","org_id":"org-1"}'
# Expect: { path: [{ course_title: "Python Basics", order: 1, why_this_fits: "..." }, ...], ai_status: "available" }
```

**Validation script:**
```bash
# After generating a path, validate ordering:
node scripts/validate-path.js
# Checks: no prereq violations, no duplicates, no completed courses
```

---

### AI07 — Enhanced Recommendations

**What to test:**
```
1. Enhanced recs
   - LMS provides baseline recs → AI adds why_this_fits
   - Each explanation references actual learner data

2. Cache
   - First call → cache miss → fetches LMS + AI03
   - Second call within 24h → cache hit → instant response

3. Fallback cascade
   - LMS recs available → enhance with AI
   - LMS recs unavailable → generate from catalogue
   - AI03 unavailable → return LMS recs without explanations
```

**How to test during dev:**
```bash
# First call (cache miss)
curl "http://localhost:8787/recommendations/dashboard?learner_id=learner-1&org_id=org-1"
# Expect: { recommendations: [{ course_title: "...", lms_reason: "...", ai_why_this_fits: "..." }] }

# Second call (should be cached — check timing)
time curl "http://localhost:8787/recommendations/dashboard?learner_id=learner-1&org_id=org-1"
# Expect: < 100ms (cache hit)

# Test cache invalidation by waiting 24h or manually clearing KV
npx wrangler kv:key delete --binding=CACHE "recs:org-1:learner-1"
```

---

## Integration Testing — Full Pipeline

Once all Workers are built, run this end-to-end test:

```bash
#!/bin/bash
# tests/integration/full-pipeline.sh
set -e

echo "=== Full AI Pipeline Integration Test ==="

# 1. Index a lesson
echo "1. Indexing lesson..."
INDEX_RESULT=$(curl -s -X POST $AI01_URL/index \
  -d '{"lesson_id":"python-functions","course_id":"python-101","module_id":"mod-1","org_id":"org-1"}')
echo "   $INDEX_RESULT"

# 2. Retrieve relevant chunks
echo "2. Retrieving chunks..."
RETRIEVE_RESULT=$(curl -s -X POST $AI02_URL/retrieve \
  -d '{"query":"How to define a function?","org_id":"org-1","scope":{"type":"lesson","id":"python-functions"}}')
echo "   Found $(echo $RETRIEVE_RESULT | jq '.chunks | length') chunks"

# 3. Ask tutor a question
echo "3. Asking tutor..."
TUTOR_RESULT=$(curl -s -X POST $AI04_URL/tutor/ask \
  -d '{"question":"What is a decorator?","lesson_id":"python-functions","course_id":"python-101","org_id":"org-1"}')
CITATION_COUNT=$(echo $TUTOR_RESULT | jq '.citations | length')
echo "   Answer received with $CITATION_COUNT citations"

# 4. Generate learning path
echo "4. Generating learning path..."
PATH_RESULT=$(curl -s -X POST $AI06_URL/paths/generate \
  -d '{"learner_id":"learner-1","org_id":"org-1"}')
PATH_COUNT=$(echo $PATH_RESULT | jq '.path | length')
echo "   Path generated with $PATH_COUNT courses"

# 5. Get recommendations
echo "5. Getting recommendations..."
RECS_RESULT=$(curl -s "$AI07_URL/recommendations/dashboard?learner_id=learner-1&org_id=org-1")
echo "   Recommendations received"

# 6. All passed
echo ""
echo "✅ Full pipeline test passed!"
```

---

## Contract Tests — AI ↔ LMS

Verify that LMS endpoints return the shape AI Workers expect:

```typescript
// tests/contracts/lms-api.test.ts
import { describe, it, expect } from 'vitest';

const LMS_URL = process.env.LMS_GATEWAY_URL!;
const API_KEY = process.env.LMS_INTERNAL_KEY!;

async function fetchLMS(path: string) {
  const res = await fetch(`${LMS_URL}/api${path}`, {
    headers: { 'X-API-Key': API_KEY, 'Accept': 'application/json' },
  });
  return res.json();
}

describe('LMS API Contracts', () => {
  it('GET /v1/lessons/{id} returns content for indexing', async () => {
    const result = await fetchLMS('/v1/lessons/python-functions');
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('content');
    expect(typeof result.data.content).toBe('string');
    expect(result.data.content.length).toBeGreaterThan(100);
  });

  it('GET /v1/catalog returns course list', async () => {
    const result = await fetchLMS('/v1/catalog');
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    if (result.data.length > 0) {
      expect(result.data[0]).toHaveProperty('id');
      expect(result.data[0]).toHaveProperty('title');
    }
  });

  it('GET /v1/learner/profile returns required fields', async () => {
    const result = await fetchLMS('/v1/learner/profile');
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('learning_stats');
  });

  it('GET /v1/progress/user returns enrollments', async () => {
    const result = await fetchLMS('/v1/progress/user');
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('enrollments');
    if (result.data.enrollments.length > 0) {
      expect(result.data.enrollments[0]).toHaveProperty('courseId');
      expect(result.data.enrollments[0]).toHaveProperty('progressPercent');
    }
  });
});
```

---

## Local Dev Workflow

```bash
# ============================================
# Daily development workflow
# ============================================

# 1. Start LMS (once)
docker compose up -d

# 2. Start tunnel (once per session)
cloudflared tunnel --url http://localhost:8000
# → https://lms-dev-abc.trycloudflare.com
# Copy this URL → set as LMS_GATEWAY_URL in wrangler.toml

# 3. Develop a Worker
cd workers/ai-tutor
npx wrangler dev
# → Worker running at http://localhost:8787

# 4. Test manually (in another terminal)
curl -X POST http://localhost:8787/tutor/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"test","lesson_id":"...","course_id":"...","org_id":"org-1"}'

# 5. Run unit tests
npx vitest run

# 6. Check traces
# Open Cloudflare Dashboard → Workers → your-worker → Observability
# Verify: fetch to LMS, Workers AI, custom LLM spans all visible

# 7. When ready, open PR
# PR checklist:
# ✅ wrangler dev passes
# ✅ vitest passes
# ✅ Manual curl test passes
# ✅ Traces visible in CF Dashboard
# ✅ AI13 dashboard card added
```

---

## PR Review Checklist

For each slice PR, reviewer verifies:

```
[ ] Worker code is ≤350 lines (including tests + instrumentation)
[ ] wrangler.toml has [observability.traces] enabled = true
[ ] All LMS calls use the shared fetchLMS() helper
[ ] AI03 calls use Service Binding (not direct fetch)
[ ] LLM spans include: model, tier, tokens, org_id, latency
[ ] Error states are handled (AI03 down → degraded response, not crash)
[ ] Unit tests cover: happy path, error path, degraded path
[ ] Contract tests pass against real LMS (tunnel running)
[ ] Manual curl test works (copy-pasteable command in PR description)
[ ] AI13 dashboard card added for this feature
```

---

## PR Size Verification

| Slice | Worker Code | Tests | Config | Total | Target | OK? |
|-------|------------|-------|--------|-------|--------|-----|
| AI03 | ~200 lines | ~60 lines | ~20 lines | ~280 | 300 | ✅ |
| AI01 | ~240 lines | ~70 lines | ~20 lines | ~330 | 350 | ✅ |
| AI02 | ~90 lines | ~40 lines | ~10 lines | ~140 | 150 | ✅ |
| AI04 | ~200 lines | ~60 lines | ~15 lines | ~275 | 300 | ✅ |
| AI08 | ~130 lines | ~45 lines | ~10 lines | ~185 | 200 | ✅ |
| AI06 | ~200 lines | ~60 lines | ~15 lines | ~275 | 300 | ✅ |
| AI07 | ~130 lines | ~45 lines | ~10 lines | ~185 | 200 | ✅ |
| AI13 | ~50 lines/wave | ~20 lines | ~10 lines | ~80/wave | 80 | ✅ |

All slices under 350 lines. Reviewable in ≤15 minutes each.
