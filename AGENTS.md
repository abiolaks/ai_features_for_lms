# AI Features for LMS — AGENTS.md

**Generated:** 2026-07-20
**Updated:** 2026-08-03

## OVERVIEW

Project: **AI Features for LMS** — AI-powered features for a Learning Management Platform
Stack: Cloudflare Workers (TypeScript 5.5+, ES2022), Workers AI (llama-3.2-3b-instruct), Vectorize, D1, KV, Durable Objects, R2, Stream, Queues, Pages
Status: **13 workers deployed, 298/298 tests passing** (ai-dashboard built, pending Pages deploy)

## COMMUNICATION STYLE

Be extremely concise. Sacrifice grammar for conciseness. Drop articles, filler words, pleasantries. Prefer terse bullet points over prose paragraphs. Examples:
- "Tests pass. Deploy to prod?" not "All the tests are passing. Would you like me to deploy to production?"
- "Bug: null ref in fetchLms line 42. Fix incoming." not "I found a bug — there's a null reference in fetchLms at line 42. I'll fix it now."

## STRUCTURE

```
ai_features_for_lms/
├── workers/
│   ├── shared/                # Shared modules (8 files) — imported by all workers
│   │   ├── cors.ts            # CORS headers, handleCors(), json() helper
│   │   ├── env.ts             # BaseEnv type (AI_GATEWAY, LMS_GATEWAY_URL, LMS_INTERNAL_KEY)
│   │   ├── fetch-lms.ts       # Authenticated LMS REST client (X-API-Key or Bearer)
│   │   ├── gateway.ts         # callGateway() — AI03 Gateway service binding wrapper
│   │   ├── lms-data.ts        # fetchProfile, fetchCatalog, fetchProgress with stub fallback
│   │   ├── observability.ts   # startSpan, setAttr, endSpan — structured console.log spans
│   │   ├── test-utils.ts      # createMockGateway, createLlmResponse, spyOnSpans
│   │   └── types.ts           # Shared TS interfaces (GenerateRequest, LmsCourse, OrgBudget, etc.)
│   ├── ai-gateway/            # AI03 — LLM Gateway (internal service binding only)
│   ├── ai-indexing/           # AI01 — Content Indexing (Stream VTT → chunk → embed → Vectorize)
│   ├── ai-tutor/              # AI04 — Grounded Q&A (Durable Objects, WebSocket)
│   ├── ai-paths/              # AI06 — Learning Path Generation
│   ├── ai-insights/           # AI08 — Post-Quiz Insights with review links
│   ├── ai-recommendations/    # AI07 — Enhanced Recommendations + fallback engine
│   ├── ai-assistant/          # F06 — Platform-wide chat assistant (Durable Objects)
│   ├── ai-mentor/             # F03a — Skill-gap analysis
│   ├── ai-bottlenecks/        # F04a — Admin bottleneck detection (aggregate analytics)
│   ├── ai-engagement/         # F04b — Admin engagement monitoring
│   ├── ai-analytics/          # F05 — Admin analytics narratives
│   ├── ai-question-gen/       # F07 — Auto-generate quiz questions
│   ├── ai-quality/            # F08 — Validate generated questions
│   ├── mentor/                # F03a duplicate (skill-gap, deployed separate)
│   └── ai-dashboard/          # AI13 — Demo Dashboard (Pages, static)
├── Issues/                    # Issue tracking (done, in-progress, future slices)
├── docs/                      # Integration guide, feature overview, PRD, tech stack
├── architecture/              # Module architecture docs
├── scripts/                   # Utility scripts
├── knowledge.md               # Session knowledge base (blockers, resolutions, decisions)
├── README.md                  # Project README with architecture and worker table
└── lmsapi.json                # LMS REST API contract (OpenAPI, 4.2MB)
```

## WORKERS

| Worker | ID | Purpose | Endpoint(s) | Tests |
|--------|----|---------|-------------|-------|
| **ai-gateway** | AI03 | LLM router — model selection, token budgeting, D1 tracking | Internal (service binding) | 14 |
| **ai-indexing** | AI01 | Content indexing — VTT → chunk → embed → Vectorize | `POST /index`, `POST /deindex` (webhook) | 17 |
| **ai-tutor** | AI04 | Grounded Q&A + Voice (STT/TTS) + WebSocket streaming | `POST /tutor/ask`, `/tutor/clear`, `WS /tutor/ws` | 33 |
| **ai-assistant** | F06 | Platform-wide chat — course discovery, topic Q&A | `POST /assistant/ask`, `/assistant/clear` | 37 |
| **ai-paths** | AI06 | Personalized learning paths | `POST /paths/generate` | 20 |
| **ai-insights** | AI08 | Post-quiz coaching + mentor session prep | `POST /insights/generate`, `/mentor/session-prep` | 62 |
| **ai-recommendations** | AI07 | Enhanced recs + fallback engine, 24h KV cache | `GET|POST /recommendations/dashboard`, `/next` | 23 |
| **ai-mentor / mentor** | F03a | Skill-gap analysis | `GET /mentor/skill-gap` | 29 |
| **ai-bottlenecks** | F04a | Admin bottleneck detection — aggregate analytics | `GET /admin/bottlenecks` | 37 |
| **ai-engagement** | F04b | Admin engagement monitoring — video drop-off, stall rates | `GET /admin/engagement` | 37 |
| **ai-analytics** | F05 | Admin analytics narratives — NL summaries, period comparison | `GET /admin/narrative` | 30 |
| **ai-question-gen** | F07 | Auto-generate quiz questions from lesson content | `POST /questions/generate` | 21 |
| **ai-quality** | F08 | Validate generated questions — accuracy, bias, clarity | `POST /questions/validate` | 20 |
| **ai-dashboard** | AI13 | Static Pages site — worker status cards | Pages deploy | Built |

## COMMANDS

All commands run from the individual worker directory (`workers/<name>/`):

| Action | Command |
|--------|---------|
| Install | `npm install` |
| Dev | `npx wrangler dev` |
| Test | `npx vitest run` |
| Deploy | `npx wrangler deploy` |
| Typegen | `npx wrangler types` |
| Tail logs | `npx wrangler tail` |

### Secrets (set per worker via `npx wrangler secret put`)

| Secret | Workers |
|--------|---------|
| `LMS_GATEWAY_URL` | ai-paths, ai-indexing, ai-recommendations, ai-insights, ai-tutor, ai-assistant, ai-mentor, ai-bottlenecks, ai-engagement, ai-analytics, ai-question-gen |
| `LMS_INTERNAL_KEY` | ai-paths, ai-indexing, ai-recommendations, ai-insights, ai-tutor, ai-assistant, ai-mentor, ai-bottlenecks, ai-engagement, ai-analytics, ai-question-gen |
| `LMS_WEBHOOK_SECRET` | ai-indexing only |
| `CLOUDFLARE_STREAM_API_TOKEN` | ai-indexing only |
| `CLOUDFLARE_ACCOUNT_ID` | ai-indexing only |

## ARCHITECTURE

```
LMS (Azure/Python) ──REST API──→ AI Workers ──→ Vectorize / Workers AI
                                           │
Learner ──→ AI Tutor / Paths / Recs / Insights ──→ AI03 Gateway (service binding) ──→ LLM
```

### Internal Service Bindings

| Binding | Used By |
|---------|---------|
| `AI_GATEWAY` → ai-gateway Worker | ai-paths, ai-tutor, ai-recommendations, ai-insights, ai-assistant, ai-mentor, ai-bottlenecks, ai-engagement, ai-analytics, ai-question-gen, ai-quality |
| `VECTORIZE_INDEX` → `lms-lessons` | ai-indexing, ai-tutor, ai-recommendations, ai-assistant, ai-question-gen |
| `INDEXING_QUEUE` → `indexing-jobs` | ai-indexing |
| `TUTOR_SESSION` → TutorSession DO | ai-tutor |
| `LMS_CACHE` → KV | ai-recommendations, ai-dashboard, ai-assistant |
| `STREAM`, `LMS_CONTENT` | ai-indexing |

### LLM Tier

| Tier | Model | Workers |
|------|-------|---------|
| Standard | `@cf/meta/llama-3.2-3b-instruct` | ai-tutor, ai-paths, ai-recommendations, ai-insights, ai-assistant, ai-mentor, ai-bottlenecks, ai-engagement, ai-quality |
| Quality | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | ai-analytics (narratives), ai-question-gen |
| Embeddings | `@cf/baai/bge-large-en-v1.5` (1024-dim) | ai-indexing, ai-tutor, ai-recommendations |

## CODING STANDARDS

- **Language**: TypeScript 5.5+, strict mode, ES2022 target, `moduleResolution: "bundler"`
- **Style**: JSDoc on all exported functions/types, ASCII-art section dividers (`═══`, `───`), explicit return types
- **Naming**: camelCase for variables/functions, PascalCase for interfaces/types, UPPER_SNAKE for constants
- **Imports**: Always use `../../shared/` for cross-worker code — **never duplicate shared logic across workers**
- **Shared modules are authoritative** — if something is in `workers/shared/`, use it. New shared helpers go there.
- **Error handling**: Every external fetch is try/caught individually. Workers return HTTP 200 with `"degraded"` status — never throw 5xx errors to the client.
- **Degraded mode**: Every worker must handle LMS unreachable, gateway failure, and unparseable LLM output gracefully, returning a stub/placeholder.
- **Observability**: Structured JSON spans via `console.log` using shared `observability.ts` helpers. Span names use dot notation (`data.fetch`, `insight.generate`, `ai_gateway.generate`). Always include `duration_ms`.
- **CORS**: All frontend-facing workers must use shared `cors.ts` (`handleCors` at top of fetch, `json()` for all responses). DO methods MUST import shared `json()` — never use a local copy.

## TESTING

- **Framework**: Vitest 2.x with `@cloudflare/vitest-pool-workers` and `cloudflare:test`
- **Per-worker**: Each worker has its own `vitest.config.ts`, `wrangler.test.jsonc`, and `test/index.test.ts`
- **Mocking**: `vi.fn` for global fetch (LMS API calls), shared `createMockGateway` for service binding, shared `createLlmResponse` for LLM output
- **Span tracking**: `vi.spyOn(console, 'log')` to capture structured JSON spans, or shared `spyOnSpans()` helper
- **Test fixture pattern**: `MOCK_*` constants at top of test file representing LMS API responses
- **Test categories per worker**: Validation, happy path, degraded mode, prompt construction, observability spans
- **Workers config**: Use `wrangler.test.jsonc` (minimal, no service bindings) — production bindings only in `wrangler.jsonc`

## API CONTRACT

The authoritative LMS API spec is `lmsapi.json` (OpenAPI, 4.2MB). For integration details see `docs/lms-integration-guide.md`.

**LMS REST endpoints consumed by workers:**
- `GET /api/v1/health` → reachability check
- `GET /api/v1/learner/profile` → profile, skills, gamification
- `GET /api/v1/learner/preferences` → knownSkills, interests, learningGoal
- `GET /api/v1/catalog?organization_id=` → course catalogue (support `per_page=100`)
- `GET /api/v1/progress/user?userId=` → enrollments + progress
- `GET /api/v1/lessons/{id}` → lesson detail + content
- `GET /api/v1/learner/assessments/{id}` → assessment metadata
- `GET /api/v1/learner/assessments/attempts/{id}` → quiz attempt + responses
- `GET /api/v1/modules/{moduleId}/lessons` → lesson listing for review links
- `GET /api/v1/learner/assessments/summary?userId=&organization_id=` → quiz summary for session prep
- `GET /api/v1/admin/progress/aggregate?organization_id=&period=` → module-level completion stats
- `GET /api/v1/admin/assessments/aggregate?organization_id=&period=` → per-topic quiz scores
- `GET /api/v1/admin/engagement?organization_id=&period=` → video watch %, course stall rates

**Auth**: `X-API-Key` header for service calls, or `Authorization: Bearer <JWT>` — handled by shared `fetch-lms.ts`.

## WHERE TO LOOK

- **Source**: `workers/<name>/src/index.ts`
- **Shared modules**: `workers/shared/`
- **Tests**: `workers/<name>/test/index.test.ts`
- **Docs**: `docs/` — integration guide, feature overview, tech-stack, PRD
- **Integration guide**: `docs/lms-integration-guide.md`
- **Feature overview**: `docs/ai-features-overview.md`
- **API spec**: `lmsapi.json` (OpenAPI, 4.2MB)
- **Architecture**: `architecture/module-architecture.md`
- **Session knowledge**: `knowledge.md`
- **Issue tracking**: `Issues/`
- **Progress**: `progress.txt`

## NOTES

- `.dev.vars` files contain secrets for local development — **never read them directly**.
- The LMS is hosted on Azure (Python/FastAPI). Workers call it via REST, never the other way around (except ai-indexing webhooks from LMS).
- ai-gateway is internal-only (service binding). All other workers are exposed to the LMS frontend.
- CORS origins include `learning.lumerax.co`, LMS staging, and localhost dev ports — configured in shared `cors.ts`.
- Durable Objects (TutorSession) use SQLite for per-learner conversation state. Deterministic routing by `learner_id`.
- The ai-dashboard worker is a Cloudflare Pages project (static), not a Worker — no `package.json` or `wrangler.jsonc`.
- Phase 1 (7 workers) and Phase 2 (6 workers) are complete and deployed. Phase 3 (F02 Mentor Matching, F09 Assessment Approval) is deferred.
- The avatar lip-sync feature (04-avatar, 10 tickets) is future work — see `Issues/ai/04-avatar/`.
- The `knowledge.md` file is a living session knowledge base — check it for past blockers, design decisions, and resolutions.
