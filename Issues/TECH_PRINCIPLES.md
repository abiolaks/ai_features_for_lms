# Technology Principles — AI Features for LMS

Applies to all slices in this `Issues/` directory. Every slice inherits these constraints.

## Stack (Cloudflare Workers + Vectorize)

| Concern | Tool | Why |
|--------|------|-----|
| **Runtime** | Cloudflare Workers (TypeScript) | Edge-deployed, zero cold starts, service bindings for internal calls |
| **Vector DB** | [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) | 1024-dim cosine index, metadata filtering, no server to manage |
| **LLM** | Workers AI (`@cf/meta/llama-3.2-3b-instruct`, `@cf/mistral/mistral-7b-instruct-v0.2-lora`) | Runs on Cloudflare's edge, no API keys, no external provider |
| **LLM Gateway** | AI03 worker — service binding pattern | Single choke point for model selection, token budgeting, D1 tracking |
| **Embeddings** | Workers AI (`@cf/qwen/qwen3-embedding-0.6b`) | 1024-dim vectors, runs on Cloudflare's edge |
| **Video Content** | Cloudflare Stream | Video hosting with AI caption generation, VTT extraction via REST API |
| **Database** | Cloudflare D1 (`lms-platform`) | SQLite-compatible, token budget tracking |
| **Cache** | Cloudflare KV (`LMS_CACHE`) | Key-value store for response caching |
| **Queue** | Cloudflare Queues (`indexing-jobs`) | Async job processing for video indexing |
| **Testing** | Vitest + `@cloudflare/vitest-pool-workers` | Worker-aware test runner, mock bindings for edge-only services |
| **Observability** | Wrangler logs + Workers Metrics dashboard | Per-worker invocation counts, error rates, latency |

## Architecture Decisions

### Direct Vectorize over AI Search
AI Search (beta) failed to persist vectors reliably. Decision: embed with Workers AI directly, upsert to our own Vectorize index. No AI Search dependency. Simpler, faster, battle-tested APIs.

### Service Bindings for Internal Calls
AI04 Tutor calls AI03 Gateway via service binding (`env.AI_GATEWAY.fetch()`). No HTTP overhead, no exposed URLs, no auth. Fast and secure.

### Post-Filter Fallback
Vectorize metadata indexes take time to propagate. Until they do, we query without `filter:` and post-filter in JavaScript. Once indexes are stable, switch to native filtering (one line change).

### Metadata Stored with Vectors
Every vector carries full metadata (`title`, `lesson_id`, `course_id`, `org_id`, `content`, `transcript_source`). No separate metadata store. The Tutor builds citations directly from Vectorize results.

### LMS Integration Stubs
Three `LMS_INTEGRATION` markers in the codebase. Each shows exactly where to add LMS API calls and which secrets to set. The markers make the handoff to the backend engineer self-documenting.

## Code Principles

### Keep It Simple
- One Worker per concern. Each Worker handles one domain (indexing, tutoring, gateway).
- Workers are ~200 lines. If approaching 300, extract helpers.
- Functions are short (≤30 lines). If longer, extract.
- Plain functions + fetch handlers. No inheritance, no classes, no frameworks.

### Comment Intent, Not Mechanics
```typescript
// GOOD: explains why
// Post-filter until Vectorize metadata indexes propagate.
// Remove when filter: param returns results reliably.
const matches = results.matches.filter(m => m.metadata?.lesson_id === lessonId);

// BAD: explains what (the code already says this)
// Filter matches by lesson_id
const matches = results.matches.filter(m => m.metadata?.lesson_id === lessonId);
```

### PR Size
- Target 200-400 lines per PR (including tests, config, comments).
- Hard ceiling: 500 lines. If approaching it, split the slice further.

### Self-Sufficient Testing
- Every Worker passes tests with `npx vitest run`
- No cloud account required for unit tests (mock AI, Vectorize, Stream bindings)
- Integration tests require `wrangler dev` with real bindings
- Tests mock at the binding boundary — we test Worker logic, not Cloudflare's inference

### API Contract
- Every Worker's endpoints are documented in `docs/api-contract.md`
- Request/response shapes, error codes, and integration flows are maintained there
- The backend engineer only needs that one document to integrate

### Issue Tracking
- Every slice has a local `.md` file in `Issues/ai/` and a linked GitHub issue
- Completed slices move to `Issues/ai/done/` and GitHub issue is closed
- Future/Phase 2+ slices live in `Issues/future/`
