# Slice 1b: Indexing Orchestrator

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 1a
- **Blocked by (external):** None (uses Azurite + mock AI Search); platform Service Bus hooks are future increment
- **User stories covered:** (infrastructure)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 1: Content Indexing Pipeline (split — orchestration concern)

## What to build

The indexing orchestrator ties together blob reads (local filesystem or Azurite), chunking (Slice 1a), and vector DB writes (LanceDB). Exposes two HTTP endpoints for development/testing:

- `POST /index?path=org-1/course-1/lesson-1.txt` — reads raw content from blob storage, chunks it (via Slice 1a HTTP call), embeds each chunk (via `sentence-transformers`), and indexes into LanceDB.
- `POST /deindex?path=org-1/course-1/lesson-1.txt` — removes all chunks for that path from LanceDB within 60 seconds.

Re-indexing the same path replaces stale chunks with fresh ones (delete-then-insert, within the 5-minute SLA). Indexing is fire-and-forget: returns 202 immediately, processing continues async.

Intermediate indexing artifacts (chunk payloads, processing logs) are written to `data/blobs/indexing/` and auto-deleted on success. On failure, artifacts are retained for debugging. All errors logged via OpenTelemetry to stdout.

**Tech note:** LanceDB is an embedded vector database — no server, no config, data stored as files under `data/lancedb/`. Embeddings generated locally with `all-MiniLM-L6-v2` (~80MB model, runs on CPU). See `Issues/TECH_PRINCIPLES.md` for the full stack.

## Acceptance criteria

- [ ] POST /index?path=org-1/course-1/lesson-1.txt → returns 202, content chunked, embedded, and indexed in LanceDB within 5 minutes
- [ ] POST /index same path again → stale chunks replaced, only fresh chunks present in LanceDB
- [ ] POST /deindex → chunks removed from LanceDB within 60 seconds
- [ ] Indexed chunks include org_id, course_id, lesson_id, section_heading, timestamp metadata
- [ ] Indexing failure → returns error, artifacts retained in `data/blobs/indexing/`
- [ ] Indexing success → artifacts auto-deleted from `data/blobs/indexing/`
- [ ] Path not found in blob storage → returns 404
- [ ] Embeddings generated locally (no API call — uses sentence-transformers)
- [ ] Self-sufficient test: copy file to `data/blobs/raw/` → POST /index → query LanceDB → verify chunks
- [ ] Self-sufficient test: POST /deindex → query LanceDB → verify chunks gone
- [ ] Unit tests: SLA timer assertions, artifact cleanup logic, error retention logic
- [ ] Integration tests: Azurite → /index → mock search query → /deindex → mock search query

## Blocked by

- Slice 0 (Azurite containers + blob directory structure)
- Slice 1a (chunking HTTP endpoint)

See `Issues/TECH_PRINCIPLES.md` for open-source stack details.
