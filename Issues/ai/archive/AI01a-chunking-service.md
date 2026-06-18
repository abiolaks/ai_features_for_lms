# Slice 1a: Chunking Service

- **Type:** AFK
- **Blocked by (internal):** Slice 0 (Azurite for Blob emulation)
- **Blocked by (external):** None (uses mock platform Blob emulator)
- **User stories covered:** (infrastructure)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 1: Content Indexing Pipeline (split — chunking concern)

## What to build

A pure-function chunking service that takes raw text content and splits it into ~512-token chunks with configurable overlap. Not opinionated about storage or indexing — those concerns live in Slice 1b.

Input: raw text + metadata (org_id, course_id, lesson_id, section heading). Output: list of chunks, each with the chunk text, its metadata, and positional info (chunk index, start/end offsets).

Chunking strategy: token-aware splitting that respects paragraph/sentence boundaries. Overlap percentage is configurable via env var (`CHUNK_OVERLAP_PCT`, default 15%). Chunk size target is configurable (`CHUNK_SIZE_TOKENS`, default 512). Uses `tiktoken` for token counting.

Exposes a simple HTTP endpoint: `POST /chunk` — accepts `{text, metadata}`, returns `{chunks: [{text, metadata, position}]}`.

No AI Search dependency. No Blob dependency. Pure text → chunks.

## Acceptance criteria

- [ ] POST /chunk with 1000-word text → returns 2+ chunks, each with metadata and position
- [ ] Chunks are ~512 tokens ± the overlap window (±15% tolerance)
- [ ] Adjacent chunks share overlapping content (configurable overlap percentage)
- [ ] Overlap is 0 when `CHUNK_OVERLAP_PCT=0`
- [ ] Chunk size target changes when `CHUNK_SIZE_TOKENS` is reconfigured
- [ ] Text shorter than chunk size → returns single chunk with all metadata
- [ ] Empty text → returns empty chunk list, no error
- [ ] Each chunk carries full source metadata (org_id, course_id, lesson_id, section_heading)
- [ ] Position metadata includes chunk_index (0-based), start_offset, end_offset
- [ ] Chunk boundaries respect sentence/paragraph breaks (no mid-sentence splits)
- [ ] Unit tests: token counting accuracy, overlap math, boundary preservation, empty input
- [ ] Integration test: POST real lesson content → verify chunk quality manually

## Blocked by

- Slice 0 (Azurite not needed for this slice, but Slice 0 establishes the shared fixtures/env)
