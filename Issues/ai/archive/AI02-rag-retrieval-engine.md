# Slice 2: RAG Retrieval Engine

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 1b
- **Blocked by (external):** None (uses mock platform + mock search backend from Slice 1b)
- **User stories covered:** (infrastructure)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 2: RAG Retrieval Engine

## What to build

A retrieval engine that takes a natural language query, org ID, and scope boundary, and returns the most relevant content chunks with citations. Exposes a single endpoint:

`POST /retrieve` — body: `{query, org_id, scope: {type: "lesson"|"module"|"course", id: "..."}}`

Returns: `{chunks: [{text, citation: {lesson_title, section_heading, timestamp?}, score}]}`

**Isolation and scoping rules:**

- **Org isolation:** The `org_id` filter is mandatory and **always** applied. Cross-org queries must return empty. This is enforced at the search query level, not in application code.
- **Scope boundaries:**
  - `lesson` → only chunks from that specific lesson
  - `module` → chunks from all lessons within that module
  - `course` → chunks from all modules within that course
- **Groundedness:** When no chunks meet the semantic relevance threshold, return an empty result set (never fabricate or guess).
- **Citations:** Every chunk includes `lesson_title`, `section_heading`, and `timestamp` (if applicable).

Uses LanceDB (same instance as Slice 1b) for vector search. Queries are embedded at search time using the same `all-MiniLM-L6-v2` model. See `Issues/TECH_PRINCIPLES.md` for the open-source stack.

## Acceptance criteria

- [ ] Query with lesson scope → only chunks from that lesson returned
- [ ] Query with module scope → chunks from all lessons in that module returned
- [ ] Query with course scope → chunks from all modules in that course returned
- [ ] Query with org-a scope on org-b's indexed content → returns empty
- [ ] Each returned chunk includes citation: lesson_title, section_heading, timestamp (if video)
- [ ] Query semantically unrelated to any content → returns empty result set
- [ ] Relevance threshold is configurable via env var
- [ ] Service starts with LanceDB backend (zero config, embedded)
- [ ] Unit tests: scope filtering logic, org isolation enforcement, citation formatting
- [ ] Unit tests: empty result handling for irrelevant queries
- [ ] Integration tests: index data via Slice 1b → retrieve with various scopes → verify boundaries

## Blocked by

- Slice 0 (mock platform for metadata resolution)
- Slice 1b (indexed data in LanceDB)

See `Issues/TECH_PRINCIPLES.md` for open-source stack details.
