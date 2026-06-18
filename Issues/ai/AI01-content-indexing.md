# AI01: Content Indexing Pipeline

- **Type:** AFK
- **Week:** 2
- **Blocked by:** AI03 (for tiktoken WASM), LMS `GET /api/v1/lessons/{id}`
- **PR target:** ~350 lines

## What to build

A Cloudflare Worker that reads lesson content from the LMS, chunks it into ~512-token segments, embeds each chunk with Workers AI `bge-m3`, and indexes into Vectorize.

**Two endpoints:**

`POST /index` — body: `{ lesson_id, course_id, module_id, org_id }`
1. Fetch lesson from LMS: `GET /api/v1/lessons/{lesson_id}` → `lesson.content`
2. Chunk into ~512-token segments with configurable overlap
3. Embed each chunk via `env.AI.run('@cf/baai/bge-m3', { text: chunk })`
4. Upsert to Vectorize with metadata: `{ org_id, course_id, module_id, lesson_id, lesson_title, section_heading, chunk_index, text }`

`POST /deindex` — body: `{ lesson_id, org_id }`
→ Delete all chunks for that lesson from Vectorize

**Tech:** Workers AI bge-m3 (1024-dim). Vectorize for storage. tiktoken WASM for token counting.

## Acceptance criteria

- [ ] Index real lesson from LMS → chunks in Vectorize with correct metadata
- [ ] Re-index same lesson → stale chunks replaced
- [ ] De-index → chunks removed within 60 seconds
- [ ] Chunks ~512 tokens ±15%
- [ ] Each chunk carries: org_id, course_id, lesson_id, section_heading, chunk_index
- [ ] `wrangler dev` with Cloudflare Tunnel to LMS → index a lesson → verify in Vectorize dashboard
- [ ] Unit tests: chunk boundaries, metadata attachment, de-index cleanup
- [ ] **Observability:** Embedding spans show model (bge-m3), chunk count, vector dimensions
- [ ] **Observability:** Vectorize upsert spans auto-traced (count, latency)
- [ ] **Observability:** LMS fetch spans auto-traced (content size, latency)
