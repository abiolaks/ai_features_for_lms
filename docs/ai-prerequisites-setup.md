# Prerequisites — AI Layer Setup

> Everything needed before writing a single line of Worker code.
> The LMS is live and hosted — no Docker, no local tunnel required.
> **Architecture:** Cloudflare AI Search for retrieval, AI03 Gateway for LLM calls.

---

## 1. LMS Access

| Item | What | Who has it |
|------|------|-----------|
| **LMS Base URL** | `https://<your-lms-domain>/api/v1` | |
| **LMS Internal Key** | `X-API-Key` header value for service-to-service auth | |

### Verify LMS is reachable

```bash
LMS_URL="https://<your-lms-domain>/api/v1"
LMS_KEY="<internal-key>"

# Catalogue
curl -s -H "X-API-Key: $LMS_KEY" "$LMS_URL/catalog" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'catalog: {len(d.get(\"data\",[]))} courses')"

# Learner profile
curl -s -H "X-API-Key: $LMS_KEY" "$LMS_URL/learner/profile" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'profile: success={d.get(\"success\")}')"

# Recommendations (to determine if AI07b fallback engine is needed)
curl -s -H "X-API-Key: $LMS_KEY" "$LMS_URL/courses/recommendations" | python3 -c "import sys,json; d=json.load(sys.stdin); data=d.get('data',''); print(f'recs: data_type={\"present\" if data else \"empty\"}, len={len(str(data))}')"

# Progress
curl -s -H "X-API-Key: $LMS_KEY" "$LMS_URL/progress/user" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'progress: success={d.get(\"success\")}')"

# Skill gaps
curl -s -H "X-API-Key: $LMS_KEY" "$LMS_URL/analytics/dashboard/skill-gaps" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'skill-gaps: success={d.get(\"success\")}')"

# Individual lesson (pick an ID from catalog)
curl -s -H "X-API-Key: $LMS_KEY" "$LMS_URL/lessons/<lesson-id>" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'lesson: has_content={\"content\" in str(d.get(\"data\",{}))}')"
```

---

## 2. LLM Provider

| Item | What | Who has it |
|------|------|-----------|
- [ ] Cloudflare Workers AI enabled on account
- [ ] Workers Paid plan (Workers AI requires it)

For local development (no API key yet), Workers AI free tier can serve as fallback — limited to 100K requests/day, works for initial testing.

---

## 3. Cloudflare Account

| Requirement | Why |
|-------------|-----|
| **Workers Paid plan** ($5/month) | Required for AI Search, D1, KV, Queues |
| **Wrangler CLI** (`npm install -g wrangler`) | Deploy, manage secrets, run locally |
| **Authenticated** (`wrangler login`) | Link CLI to your account |

### Resources to create after account is ready

```bash
# D1 database — budget tracking, enrollment patterns
wrangler d1 create lms-platform

# KV namespace — recommendations cache, health status
wrangler kv:namespace create LMS_CACHE

# Queues — async indexing jobs
wrangler queues create indexing-jobs

# R2 bucket — raw lesson text storage (optional, AI Search has built-in storage)
wrangler r2 bucket create lms-content
```

### AI Search — Provision instances per org

AI Search replaces Vectorize. Every org gets 3 instances in the `lms-platform` namespace:

```bash
# The namespace is auto-created on first deploy with the binding.
# Instances are created via the Worker (AI01 creates them on first use):
#
#   org-{id}-courses      — course titles, descriptions, metadata
#   org-{id}-lessons      — full lesson content, transcripts, headings  
#   org-{id}-assessments  — quiz questions, rubrics, marking criteria
#
# No CLI command needed — AI01 Worker calls instance.create() on first index.

# For manual testing, create via Dashboard:
# Cloudflare Dashboard → AI Search → Create Instance
#   ID: org-test-lessons
#   Type: Empty (Items API)
#   Index method: Vector + Keyword (hybrid)
#   Chunk size: 512
#   Chunk overlap: 64
#   Reranking: Enabled
```

### What we DON'T need

- ❌ **Vectorize** — replaced by AI Search
- ❌ **bge-m3 embedding config** — AI Search handles embeddings automatically
- ❌ **tiktoken WASM** — no manual token counting needed

### Cloudflare Stream (for video transcript extraction)

AI01 needs access to the Cloudflare Stream API to generate and fetch captions:

```bash
# Required secrets for AI01 Worker
npx wrangler secret put CLOUDFLARE_API_TOKEN    # Stream API access
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID   # For Stream REST API calls
npx wrangler secret put LMS_WEBHOOK_SECRET      # Verify webhook authenticity
```

Stream AI captioning cost: **$0.10 per minute** of video. One-time per video (captions are stored).

---

## 4. Project Scaffold

```
workers/
├── shared/
│   ├── fetch-lms.ts          # fetchLMS() — all workers use this
│   ├── types.ts              # Shared TypeScript types
│   └── observability.ts      # Tracing helpers
├── ai-gateway/               # AI03 — BUILD FIRST (Week 1)
│   ├── src/index.ts
│   ├── test/index.test.ts
│   ├── wrangler.toml
│   └── package.json
├── ai-indexing/              # AI01 (Week 2)
├── ai-tutor/                 # AI04 (Week 3)
├── ai-insights/              # AI08 (Week 3)
├── ai-paths/                 # AI06 (Week 4)
├── ai-recommendations/       # AI07 (Week 5)
└── ai-dashboard/             # AI13 (ongoing)
```

Note: **No `ai-retrieval/`** — AI Search handles retrieval. AI04 calls AI Search directly.

---

## 5. Wrangler Configuration

### AI Search Binding (in every worker that queries content)

```toml
# wrangler.toml (AI04 Tutor, AI01 Indexing)
[[ai_search_namespaces]]
binding = "AI_SEARCH"
namespace = "lms-platform"
```

### Service Bindings

```toml
# All feature workers (AI04, AI06, AI07, AI08)
[[services]]
binding = "AI_GATEWAY"
service = "ai-gateway"
```

---

## 6. Secrets to Configure

```bash
# AI03 Gateway
cd workers/ai-gateway

# All workers that call the LMS
npx wrangler secret put LMS_GATEWAY_URL     # https://<your-lms-domain>/api
npx wrangler secret put LMS_INTERNAL_KEY
```

---

## 7. Decision Gates

### Gate 1: LMS recommendations quality (check before Week 5)

```bash
curl -s -H "X-API-Key: $LMS_KEY" "$LMS_URL/courses/recommendations"
```

| If LMS returns... | Then... |
|-------------------|---------|
| Real, personalized course recommendations | **Skip** AI07b — AI07 just enhances with explanations |
| Generic, hardcoded, or empty results | **Build** `Issues/ai/AI07b-recommendations-fallback-engine.md` |
| 404 or error | **Build** AI07b — it becomes the primary recommendation engine |

---

## Build Order

```
Week 1: AI03 LLM Gateway          ← START HERE
Week 2: AI01 Content Indexing     ← Provision AI Search instances
Week 3: AI04 Tutor + AI08 Insights ← Parallel (Tutor needs AI01 lessons indexed)
Week 4: AI06 Learning Paths       ← ⚠️ Data quality gate must pass first
Week 5: AI07 Enhanced Recs        ← (+ AI07b if LMS recs insufficient)
Ongoing: AI13 Demo Dashboard      ← One card added per slice
```

---

## Quick Start (once prerequisites are met)

```bash
# 1. Scaffold + deploy AI03
cd workers/ai-gateway
npx wrangler deploy

# 2. Test
curl -X POST https://ai-gateway.<your-subdomain>.workers.dev/generate \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"tier":"standard","org_id":"org-1"}'

# 3. If it works → AI03 done. Create AI Search instances, then move to AI01.
```

---

## Status

| Item | Status |
|------|--------|
| LMS Base URL | ☐ |
| LMS Internal Key | ☐ |

| Cloudflare account (Paid) | ☐ |
| Wrangler installed + authenticated | ☐ |
| D1 database created | ☐ |
| KV namespace created | ☐ |
| AI Search namespace + instances provisioned | ☐ |
| Queues created | ☐ |
| R2 bucket created | ☐ |
| Project scaffolded | ☐ |
| AI03 Gateway | pending |
| AI01 Indexing | pending |
| AI04 Tutor | pending |
| AI08 Post-Quiz Insights | pending |
| AI06 Learning Paths | pending |
| AI07 Enhanced Recs | pending |
| AI13 Demo Dashboard | pending |
