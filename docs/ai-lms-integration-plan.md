# AI ↔ LMS Integration Plan

> How the AI features plug into the existing LMS platform. One gateway, one auth flow, one truth.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Learner Browser                           │
│                  (LMS Frontend + Web Components)              │
└────────────┬────────────────────────────┬───────────────────┘
             │                            │
             │ HTTPS                      │ HTTPS
             ▼                            ▼
┌────────────────────────┐    ┌───────────────────────────────┐
│  LMS Platform Gateway   │    │    Cloudflare Workers          │
│  (FastAPI, port 8000)   │    │    (Edge, global)              │
│                         │    │                                │
│  Auth at edge           │    │  AI04a Tutor                   │
│  X-API-Key →            │    │  AI06 Learning Paths           │
│  X-Learner-ID            │    │  AI07 Recommendations          │
│                         │    │  AI08 Post-Quiz Insights       │
│  Routes to:             │    │  AI09 Platform Assistant       │
│  P03 Content (8010)     │    │  AI10a Question Generation     │
│  P05 Accounts (8011)    │    │  AI10b Approval Workflow       │
│  P06 Catalogue (8012)   │    │  AI11 Quality Checks           │
│  P07 Progress (8013)    │    │  AI12 Fail Gracefully          │
│  P08 Quizzes (8014)     │    │                                │
│  P09 Admin (8015)       │    │  Infrastructure:               │
│                         │    │  ├─ Vectorize (bge-m3)         │
│                         │    │  ├─ D1 (SQLite)               │
│                         │    │  ├─ R2 (files)                │
│                         │    │  ├─ KV (cache)                │
│                         │    │  └─ Durable Objects (sessions)│
└────────┬───────────────┘    └───────────┬───────────────────┘
         │                                │
         │ SQLite                         │ fetch (HTTPS)
         ▼                                ▼
┌─────────────────┐
│  SQLite DB       │
│  (shared file)   │
│                  │
│  courses         │
│  learners        │
│  enrollments     │
│  quizzes         │
│  org_config      │
└─────────────────┘
```

**Three domains, one system:**

| Domain | Runtime | Location | Responsibility |
|--------|---------|----------|----------------|
| **LMS Platform** | FastAPI + SQLite | Local / Docker | Courses, accounts, progress, quizzes, gateway |
| **AI Services** | Cloudflare Workers | Cloudflare Edge | Tutor, paths, recs, insights, assistant, assessments |
| **LLM** | Workers AI | Cloudflare Edge | Text generation (Llama 3.2 / Mistral) |

---

### How AI Workers Talk to the LMS

```
AI Worker (Cloudflare Edge)
  │
  │  fetch("https://lms.example.com/api/...", {
  │    headers: { "X-API-Key": LMS_INTERNAL_KEY }
  │  })
  ▼
LMS Platform Gateway (FastAPI, port 8000)
  │
  │  Validates internal key → full trust
  │  Routes to backend service
  ▼
LMS Backend Service (P03 Content, P06 Catalogue, etc.)
```

**For local development:** The LMS Gateway must be reachable by Cloudflare Workers.
Two options:

| Option | How | Best for |
|--------|-----|----------|
| **Cloudflare Tunnel** | `cloudflared tunnel` exposes localhost:8000 via `*.trycloudflare.com` | Development, testing |
| **wrangler dev --remote** | Workers run on Cloudflare edge, call your tunnel URL | Integration testing |

```bash
# Terminal 1: Start LMS platform
docker compose up

# Terminal 2: Expose gateway to Cloudflare
cloudflared tunnel --url http://localhost:8000
# → https://lms-dev-xyz.trycloudflare.com

# Terminal 3: Run AI worker in dev mode
cd ai-gateway
LMS_GATEWAY_URL=https://lms-dev-xyz.trycloudflare.com wrangler dev
```

---

## Data Contracts — What Each AI Worker Needs from LMS

> AI Workers call the LMS Gateway over HTTPS using an internal API key.
> The Gateway validates the key and routes to the correct backend service.

### AI03 — LLM Gateway Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/accounts/orgs/{org_id}/config
  → { budget_limit, budget_used }

CALLS WORKERS AI:
  env.AI.run(model, { messages, max_tokens })
  → Standard tier: @cf/meta/llama-3.2-3b-instruct
  → Quality tier:  @cf/mistral/mistral-7b-instruct-v0.2

CALLED BY: All other AI Workers via Service Bindings
```

### AI04a — Tutor Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/content/lessons/{lesson_id}
  → { title, content, module: { title, course: { title } } }

NEEDS FROM CF INFRA:
  Vectorize query     → RAG chunks (bge-m3 embedding → vector search)
  AI03 Service Binding → LLM response (Workers AI via Gateway Worker)

EXPOSES TO FRONTEND:
  POST /tutor/ask
  → body: { question, lesson_id, module_id, course_id, conversation_id? }
  ← { answer, citations, scope_expansion_suggested }
```

### AI05 — Learner Profile Worker
```
CREATES ITS OWN DATA (D1):
  POST /profiles       → create profile
  GET  /profiles/{id}  → read profile

NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/content/tags?domain=skill
  → skill taxonomy for validation
```

### AI06 — Learning Paths Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/catalogue             → full course catalogue
  GET https://{LMS_GATEWAY}/api/progress/{learner_id} → enrollment + completion

NEEDS FROM CF INFRA:
  D1 query (AI05 profile)     → learner skills + goals
  AI03 Service Binding         → LLM response

EXPOSES TO FRONTEND:
  POST /paths/generate
  → body: { learner_id }
  ← { path: [{course, module, order, why_this_fits}], ai_status }
```

### AI07 — Recommendations Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/catalogue
  GET https://{LMS_GATEWAY}/api/progress/{learner_id}
  GET https://{LMS_GATEWAY}/api/content/courses/{id}/prerequisites

NEEDS FROM CF INFRA:
  D1 query (AI05 profile)  → learner profile
  AI03 Service Binding      → LLM response
  KV cache                  → cached recommendations (24h TTL)

EXPOSES TO FRONTEND:
  GET /recommendations/dashboard?learner_id=X
  GET /recommendations/because?learner_id=X&completed_course_id=Y
  GET /recommendations/next?learner_id=X&course_id=Y
```

### AI08 — Post-Quiz Insights Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/content/lessons/{lesson_id}
  → lesson structure (for review links)

  Quiz results come in request body (frontend provides them)

NEEDS FROM CF INFRA:
  AI03 Service Binding  → LLM response

EXPOSES TO FRONTEND:
  POST /insights/generate
  → body: { quiz_data: {questions, answers, correct}, lesson_id, learner_id }
  ← { insight_text, missed_topics: [{topic, review_link}], tone_check }
```

### AI09 — Platform Assistant Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/progress/{learner_id}
  GET https://{LMS_GATEWAY}/api/content/lessons/{lesson_id}

NEEDS FROM CF INFRA:
  AI03 Service Binding  → LLM response
  Durable Object        → conversation history

EXPOSES TO FRONTEND:
  POST /assistant/ask
  → body: { question, learner_id, current_lesson_id? }
  ← { answer, action_type: "progress"|"content"|"general" }
```

### AI10a — Question Generation Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/content/lessons/{lesson_id}
  → lesson content + difficulty

NEEDS FROM CF INFRA:
  Vectorize query         → RAG chunks from lesson
  AI03 Service Binding     → LLM response (quality tier → Mistral)

EXPOSES TO FRONTEND:
  POST /assessments/generate
  → body: { lesson_id, question_count, difficulty }
  ← { assessment_id, questions: [{text, options, correct, source_excerpt}] }
```

### AI10b — Approval Workflow Worker
```
STORES IN D1: Question state machine (pending → approved → rejected)

EXPOSES TO FRONTEND:
  POST /assessments/{id}/questions/{qid}/approve
  POST /assessments/{id}/questions/{qid}/reject
  POST /assessments/{id}/approve-all
  POST /assessments/{id}/reject-all
```

### AI11 — Quality Checks Worker
```
NEEDS FROM LMS:
  GET https://{LMS_GATEWAY}/api/content/courses/{course_id}
  → course difficulty

NEEDS FROM CF INFRA:
  Vectorize similarity search  → duplicate detection
  AI03 Service Binding          → reading level check (LLM)

EXPOSES TO FRONTEND:
  POST /quality/check
  → body: { assessment_id }
  ← { duplicates: [{q1, q2, score}], reading_level_issues: [...], can_publish }
```

---

## Auth Flow

```
1. Learner logs into LMS frontend → gets API key
2. Frontend calls AI Worker directly with X-Learner-ID + X-Org-ID headers
   (LMS already authenticated the user before rendering the page)
3. AI Worker calls LMS Gateway for data:
   fetch(LMS_GATEWAY_URL + "/api/catalogue", {
     headers: { "X-API-Key": env.LMS_INTERNAL_KEY }
   })
4. LMS Gateway validates internal key → returns requested data
5. AI Worker processes data, calls Workers AI for LLM, returns result to frontend
```

**Why two auth paths?**
- Frontend → LMS: Learner's key (scoped to their org + identity)
- AI Worker → LMS: Internal service key (full read access, no write)

The AI Worker doesn't impersonate the learner — it fetches data it needs to answer the learner's question, scoped by org_id. The LMS Gateway trusts the internal key and returns data for any org.

**Worker code pattern:**

```typescript
// Every AI Worker uses this pattern to call the LMS
async function fetchFromLMS(path: string, env: Env): Promise<Response> {
  return fetch(`${env.LMS_GATEWAY_URL}${path}`, {
    headers: {
      "X-API-Key": env.LMS_INTERNAL_KEY,
      "Content-Type": "application/json",
    },
  });
}

// Example: AI06 Learning Paths Worker fetches catalogue
const catalogue = await fetchFromLMS(
  `/api/catalogue?org_id=${orgId}`,
  env
).then(r => r.json());
```

---

## Error Handling — Three-Layer Resilience

| Scenario | Frontend → AI Worker | AI Worker → LMS | AI Worker → Workers AI |
|----------|----------------------|-----------------|------------------------|
| Auth failure | Worker returns 401 | Gateway returns 401 | — |
| Service down | Worker returns 503 | Worker catches, returns degraded (AI12) | Gateway returns 502 |
| Timeout | Worker returns 504 after 30s | Worker catches, returns degraded | Gateway catches, returns degraded |
| Budget exhausted | — | — | AI03 returns 429, Worker surfaces to user |
| No RAG results | Worker returns "not found" | — | — |

**Fallback hierarchy (built into AI03 Gateway Worker):**

```
1. Call Workers AI (Llama 3.2 standard / Mistral quality)
2. If Workers AI fails → return 502 with degradation notice

Embeddings: Workers AI bge-m3 is always available on Cloudflare.
```

---

## Configuration — Per Worker

```toml
# wrangler.toml — AI03 LLM Gateway Worker
name = "ai-gateway"

[vars]
LMS_GATEWAY_URL = "https://lms-dev-xyz.trycloudflare.com"  # dev
# LMS_GATEWAY_URL = "https://lms.example.com"              # prod
# Secrets (never in code)
# npx wrangler secret put LMS_INTERNAL_KEY

[[d1_databases]]
binding = "DB"
database_name = "lms-ai"

[[vectorize]]
binding = "VECTOR_INDEX"
index_name = "lms-chunks"

# AI03 is called by other Workers via Service Bindings
# Other Workers declare:
# [[services]]
# binding = "AI_GATEWAY"
# service = "ai-gateway"
```

```toml
# wrangler.toml — AI06 Learning Paths Worker
name = "ai-paths"

[vars]
LMS_GATEWAY_URL = "https://lms-dev-xyz.trycloudflare.com"

[[services]]
binding = "AI_GATEWAY"
service = "ai-gateway"

# Secrets
# npx wrangler secret put LMS_INTERNAL_KEY
```

---

## Build Order — LMS Already Built, Adding AI Layer

```
Phase 1: Gateway + Tunnel (Day 1)
  ├── LMS Gateway: Add /api/accounts/orgs/{id}/config endpoint (budget data)
  ├── LMS Gateway: Add internal key auth (LMS_INTERNAL_KEY in env)
  ├── Cloudflare Tunnel: Expose localhost:8000 for Worker dev
  └── Verify: AI Worker can fetch LMS catalogue via tunnel

Phase 2: AI03 LLM Gateway Worker (Week 1)
  ├── Worker: POST /generate with Workers AI
  ├── Worker: Budget enforcement (D1)
  └── Test: Call from curl, verify AI response + token tracking

Phase 3: Data Pipeline (Week 2)
  ├── AI01 Chunking + Embedding: Workers AI bge-m3
  ├── AI01b Indexing: Vectorize + R2 + Queues
  ├── AI02 RAG Retrieval: Vectorize query with org scoping
  └── Test: Index a lesson, query it, verify chunk retrieval

Phase 4: Core AI Features (Week 3-4)
  ├── AI05 Learner Profile Worker (D1, validates against LMS skill taxonomy)
  ├── AI04a Tutor Worker (Vectorize + AI03 → grounded Q&A)
  ├── AI06 Learning Paths Worker (LMS catalogue + profile → AI03)
  ├── AI07 Recommendations Worker (LMS catalogue + progress → AI03 + KV cache)
  ├── AI08 Post-Quiz Insights Worker (LMS lesson structure → AI03)
  └── AI09 Platform Assistant Worker (LMS progress → AI03 + DO history)

Phase 5: Assessment Pipeline (Week 5)
  ├── AI10a Question Generation Worker (LMS lessons + Vectorize → AI03 quality)
  ├── AI10b Approval Workflow Worker (D1 state machine)
  └── AI11 Quality Checks Worker (Vectorize duplicates + AI03 reading level)

Phase 6: Resilience (Week 6)
  ├── AI04b Tutor History Worker (Durable Objects)
  └── AI12 Fail Gracefully Worker (KV health checks, degradation signals)

Phase 7: Demo Dashboard (Continuous — every Phase adds cards)
  └── AI13 Demo Dashboard (Pages, cumulative across all phases)
```

**Parallel work possible:**
- Phase 3 (Data Pipeline) and Phase 2 (Gateway) can overlap once AI03 is stable
- Phase 4 features (Tutor, Paths, Recs, Insights, Assistant) can all be built in parallel — they only depend on AI03 + LMS
- Phase 5 (Assessments) only needs AI03 + Vectorize, can start as soon as data pipeline ships

**Each Worker is independently deployable** — no orchestration needed between Workers. They share infra (D1, Vectorize, KV) but don't call each other directly (only via Service Bindings to AI03).

---

---

## Key Decisions

1. **AI Workers call LMS Gateway over HTTPS.** AI Workers run on Cloudflare's edge — they can't reach `localhost`. The LMS Gateway must be publicly reachable (via Cloudflare Tunnel in dev, real domain in prod).

2. **Frontend calls AI Workers directly.** The LMS Gateway doesn't proxy AI requests. The frontend gets an AI Worker URL and calls it client-side. This eliminates a hop and keeps the Gateway simple.

3. **AI Workers are stateless** (except Durable Objects for conversation history). All persistent data lives in D1 (SQLite on Cloudflare) or in the LMS SQLite database.

4. **AI03 Gateway Worker is the only Worker that talks to Workers AI.** No other Worker calls `env.AI.run()` directly. Change models by changing one Worker.

5. **No circular dependencies.** LMS platform knows nothing about AI Workers. AI Workers know about LMS endpoints but LMS never calls AI Workers.

6. **Cloudflare infra replaces local tools:**
   | Local (original plan) | Cloudflare (actual) |
   |---|---|
   | LanceDB | Vectorize |
   | sentence-transformers | Workers AI bge-m3 |
   | SQLite (AI data) | D1 |
   | Local filesystem | R2 |
   | cachetools LRU | KV |
   | Ollama (local LLM) | Workers AI (via AI03) |

7. **AI13 Demo Dashboard proves integration.** Each AI card added to the dashboard demonstrates the full chain: LMS data → AI Worker → Workers AI → rendered result. Built incrementally across all phases.

---

## Local Development Setup

```bash
# 1. Start LMS platform
docker compose up -d
# → Gateway on localhost:8000
# → Phoenix on localhost:6006

# 2. Expose Gateway to internet (for Workers to reach)
cloudflared tunnel --url http://localhost:8000
# → https://lms-dev-abc123.trycloudflare.com

# 3. Set the tunnel URL as LMS_GATEWAY_URL in each Worker's wrangler.toml
# Or: wrangler secret put LMS_GATEWAY_URL

# 4. Deploy AI03 Gateway Worker first
cd workers/ai-gateway
npx wrangler secret put LMS_INTERNAL_KEY
npx wrangler deploy

# 5. Develop other Workers locally against deployed AI03
cd workers/ai-tutor
npx wrangler dev

# 6. Run integration tests
npx vitest --run
```
