# Part 10: File-by-File Reference

Every file in the repo, what it does, and when to look at it.

## Root Files

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent instructions — coding standards, worker list, commands, architecture |
| `CONTEXT.md` | Domain glossary — TutorSession, TutorExchange, TutorPersona, InteractionMode, AnswerDelivery |
| `README.md` | Project overview, worker table, quickstart |
| `knowledge.md` | Living session knowledge — blockers, resolutions, decisions (60KB+) |
| `progress.txt` | Deployment status, test counts, pending items |
| `blockers-and-resolutions.md` | Historical blocker log |
| `lmsapi.json` | LMS REST API contract (OpenAPI, 4.2MB) — authoritative for LMS endpoints |
| `lms-content-export.json` | Sample LMS content export for testing |
| `api.html` | Visual API reference |

## `workers/shared/` (9 files)

| File | Lines | Purpose |
|------|-------|---------|
| `types.ts` | ~80 | Shared interfaces: GenerateRequest, LmsCourse, LmsLesson, etc. |
| `cors.ts` | ~65 | CORS headers, json() helper, handleCors() preflight — every worker uses this |
| `fetch-lms.ts` | ~60 | LMS REST client with X-API-Key/Bearer auth + fetchLmsResource<T> generic |
| `gateway.ts` | ~45 | callGateway() — wraps AI_GATEWAY service binding, returns {text, model, tokens} |
| `lms-data.ts` | ~120 | fetchProfile, fetchCatalog, fetchProgress — all return {data, fromLms} with stub fallback |
| `observability.ts` | ~30 | startSpan, setAttr, endSpan — structured JSON spans via console.log |
| `test-utils.ts` | ~55 | createMockGateway, createLlmResponse, spyOnSpans — shared test factories |
| `llm-parser.ts` | ~75 | parseLlmJson<T> — handles markdown blocks, truncated JSON, array responses |
| `sanitize.ts` | ~15 | sanitize() — strips quotes, trims, caps length |
| `env.ts` | ~5 | BaseEnv type with AI_GATEWAY, LMS_GATEWAY_URL, LMS_INTERNAL_KEY |

## Worker Source Files

| Worker | File | Lines | Key Content |
|--------|------|-------|------------|
| **ai-gateway** | `src/index.ts` | ~200 | POST /generate, POST /stream (SSE), budget tracking, model map |
| **ai-indexing** | `src/index.ts` | ~500 | POST /index, /deindex, /extract-pdf, VTT extraction, chunking, embed+upsert |
| **ai-tutor** | `src/index.ts` | ~200 | Fetch handler: CORS, injection defense, routing to DO |
| | `src/TutorSession.ts` | ~450 | DO: ask(), WebSocket streaming, voice pipeline (STT→correct→TTS), prompt builder |
| **ai-assistant** | `src/index.ts` | ~160 | Fetch handler: CORS, injection defense, routing to DO |
| | `src/AssistantSession.ts` | ~350 | DO: ask(), retrieve (org-scoped Vectorize), course suggestions, prompt builder |
| **ai-paths** | `src/index.ts` | ~180 | Profile + catalogue + progress → structured learning path |
| **ai-recommendations** | `src/index.ts` | ~300 | Enhanced + fallback engine, KV cache, content similarity |
| **ai-insights** | `src/index.ts` | ~400 | Quiz analysis, review links, mentor session prep |
| **ai-mentor** | `src/index.ts` | ~200 | Skill-gap matrix, catalogue matching |
| **ai-bottlenecks** | `src/index.ts` | ~250 | Aggregate analytics, per-module severity |
| **ai-engagement** | `src/index.ts` | ~250 | Video drop-off, stall rates, activity patterns |
| **ai-analytics** | `src/index.ts` | ~200 | NL narratives, period comparisons (quality tier) |
| **ai-question-gen** | `src/index.ts` | ~200 | Quiz question generation from lesson content (quality tier) |
| **ai-quality** | `src/index.ts` | ~180 | Question validation: accuracy, bias, clarity, distractors |

## Test Files

| Worker | File | Tests |
|--------|------|-------|
| ai-gateway | `test/index.test.ts` | 14 |
| ai-indexing | `test/index.test.ts` | 17 |
| ai-tutor | `test/index.test.ts` | 44 |
| ai-assistant | `test/index.test.ts` | 39 |
| ai-paths | `test/index.test.ts` | 20 |
| ai-recommendations | `test/index.test.ts` | 23 |
| ai-insights | `test/index.test.ts` | 62 |
| ai-mentor | `test/index.test.ts` | 29 |
| ai-bottlenecks | `test/index.test.ts` | 37 |
| ai-engagement | `test/index.test.ts` | 37 |
| ai-analytics | `test/index.test.ts` | 30 |
| ai-question-gen | `test/index.test.ts` | 21 |
| ai-quality | `test/index.test.ts` | 20 |
| **Total** | | **393** (not 408 — some workers have additional test files) |

## Configuration Files (per worker)

| File | Purpose |
|------|---------|
| `package.json` | Dependencies: cloudflare:workers, vitest, typescript |
| `tsconfig.json` | TypeScript 5.5+, strict, ES2022, bundler moduleResolution |
| `vitest.config.ts` | @cloudflare/vitest-pool-workers, 10s timeout |
| `wrangler.jsonc` | Production: name, main, compatibility_date, bindings, queues, DO classes |
| `wrangler.test.jsonc` | Test: name, main, compatibility_date (minimal, no real bindings) |

## Documentation (`docs/`)

| File | Purpose |
|------|---------|
| `lms-integration-guide.md` | How workers integrate with the LMS REST API |
| `ai-features-overview.md` | Feature descriptions for all 13 workers |
| `tech-stack.md` | Technology choices and rationale |
| `prd.md` | Product requirements document |

## Architecture (`architecture/`)

| File | Purpose |
|------|---------|
| `module-architecture.md` | Complete architecture doc — diagram, worker table, ADRs, resource map |

## Scripts (`scripts/`)

Utility scripts for development, testing, deployment.
