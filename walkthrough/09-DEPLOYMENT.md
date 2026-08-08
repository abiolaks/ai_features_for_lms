# Part 9: Deployment & Operations

## Per-Worker Setup

Every worker has the same structure:
```
workers/<name>/
├── package.json        # Dependencies (shared via npm workspaces)
├── tsconfig.json       # TypeScript 5.5+, ES2022, bundler moduleResolution
├── vitest.config.ts    # @cloudflare/vitest-pool-workers
├── wrangler.jsonc      # Production bindings
├── wrangler.test.jsonc # Test bindings (minimal)
├── src/
│   └── index.ts        # Entry point (+ DO class if applicable)
└── test/
    └── index.test.ts   # All tests
```

## Commands

```bash
# From worker directory:
npm install                           # Install deps
npx wrangler dev                      # Local dev server
npx vitest run                        # Run tests
npx wrangler deploy                   # Deploy to Cloudflare
npx wrangler tail                     # Live logs (structured JSON spans)
npx wrangler types                    # Generate env type bindings
```

## Secrets (per worker via `npx wrangler secret put`)

| Secret | Workers |
|--------|---------|
| `LMS_GATEWAY_URL` | All 12 frontend workers |
| `LMS_INTERNAL_KEY` | All 12 frontend workers |
| `LMS_WEBHOOK_SECRET` | ai-indexing only |
| `CLOUDFLARE_STREAM_API_TOKEN` | ai-indexing only |
| `CLOUDFLARE_ACCOUNT_ID` | ai-indexing only |

## Service Bindings

| Binding | Workers That Use It |
|---------|-------------------|
| `AI_GATEWAY` → ai-gateway | All 12 frontend workers |
| `VECTORIZE_INDEX` → lms-lessons | ai-indexing, ai-tutor, ai-recommendations, ai-assistant, ai-question-gen |
| `INDEXING_QUEUE` → indexing-jobs | ai-indexing |
| `TUTOR_SESSION` → TutorSession DO | ai-tutor |
| `ASSISTANT_SESSION` → AssistantSession DO | ai-assistant |
| `LMS_CACHE` → KV | ai-recommendations, ai-dashboard, ai-assistant |
| `STREAM`, `LMS_CONTENT` → R2 | ai-indexing |

## Observability (what you see in `wrangler tail`)

Every request emits structured JSON spans to `console.log`:

```
{"span":"tutor.request","duration_ms":2,"method":"POST","path":"/tutor/ask","status":200}
{"span":"tutor.embed","duration_ms":45,"text_len":22,"model":"@cf/baai/bge-large-en-v1.5","dimensions":1024}
{"span":"tutor.vectorize","duration_ms":12,"topK":50,"scope":"lesson","raw_matches":5,"after_filter":3}
{"span":"tutor.gateway","duration_ms":1234,"tier":"standard","status":200,"tokens":87}
{"span":"tutor.ask","duration_ms":1356,"org_id":"org-test","citations":3,"history_size":4}

{"span":"assistant.request","duration_ms":1,"method":"GET","path":"/health","status":200}
{"span":"assistant.injection_blocked","duration_ms":0,"pattern":"ignore_instructions","question_length":48}
```

## Error Handling Philosophy

**Rule: Never return 5xx to the LMS frontend.**

Every external call is try/caught individually. On failure:
- LMS unreachable → use stub data (`fromLms: false`)
- Gateway unreachable → return degraded answer with only citations
- Vectorize empty → "I couldn't find that"
- LLM unparseable → graceful extraction (`parseLlmJson`, `stripJsonBlock`)

The LMS frontend handles degraded responses without crashing. A missing feature is better than an error page.

## Local Development

```bash
# .dev.vars (NOT committed, in .gitignore)
LMS_GATEWAY_URL=http://localhost:8000/api
LMS_INTERNAL_KEY=dev-key-123

# Start a worker locally:
cd workers/ai-tutor && npx wrangler dev

# Test locally:
cd workers/ai-tutor && npx vitest run

# All tests:
for d in workers/ai-*/; do cd "$d" && npx vitest run && cd ../..; done
```

## Adding a New Worker

1. Copy an existing worker directory (e.g., `cp -r workers/ai-paths workers/ai-new-feature`)
2. Update `wrangler.jsonc`:
   - Change `name`
   - Update bindings (at minimum: AI_GATEWAY, LMS_GATEWAY_URL, LMS_INTERNAL_KEY)
3. Write `src/index.ts` following the fetch handler pattern
4. Write `test/index.test.ts` following the test patterns
5. Add to `workers/shared/types.ts` if new types needed
6. Deploy: `npx wrangler deploy`
7. Update architecture docs
