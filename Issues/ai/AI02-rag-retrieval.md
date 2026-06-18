# AI02: RAG Retrieval Engine

- **Type:** AFK
- **Week:** 2
- **Blocked by:** AI01 (Vectorize must have indexed data)
- **PR target:** ~150 lines

## What to build

A lightweight Worker that embeds a natural-language query and searches Vectorize for relevant content chunks.

**One endpoint:**

`POST /retrieve` — body: `{ query, org_id, scope: { type: "lesson"|"module"|"course", id: "..." } }`
→ response: `{ chunks: [{ text, citation: { lesson_title, section_heading }, score }] }`

**Behavior:**
1. Embed query via Workers AI `bge-m3`
2. Query Vectorize with metadata filter: `{ org_id, [scope_type]_id }`
3. Return chunks above relevance threshold (configurable, default 0.7)
4. No chunks above threshold → return `{ chunks: [] }` (never fabricate)

**Scope types:**
- `lesson` → only chunks from that specific lesson
- `module` → chunks from all lessons in that module  
- `course` → chunks from all modules in that course

## Acceptance criteria

- [ ] Query about indexed content → returns relevant chunks with citation metadata + scores
- [ ] Query about unrelated topic → returns `{ chunks: [] }`
- [ ] Lesson scope → only that lesson's chunks returned
- [ ] Module scope → chunks from all lessons in module
- [ ] Course scope → chunks from all modules in course
- [ ] Org isolation: org-1 query never returns org-2 chunks (Vectorize filter enforces)
- [ ] Unit tests: scope filtering, empty results, relevance threshold
- [ ] **Observability:** Retrieval spans include query text, result count, top-3 scores
- [ ] **Observability:** Empty result spans marked with `retrieval.empty: true`
