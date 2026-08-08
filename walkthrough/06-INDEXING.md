# Part 6: Content Indexing (ai-indexing)

The ingestion pipeline. Converts LMS content (videos, PDFs, PPTs, text) into searchable vectors.

## Worker Structure

```
workers/ai-indexing/src/index.ts    ← All in one file (~500 lines)
  ├── fetch handler: 11 endpoints (diag + webhook + queue consumer)
  ├── Queue consumer: processes index jobs async
  ├── Video pipeline: VTT extraction + caption generation
  ├── PDF/PPTX extraction: unpdf + raw parsing
  ├── Chunking: ~2000 chars, sentence boundaries
  ├── Embedding: bge-large-en-v1.5 (1024-dim)
  └── Vectorize: batch upsert (10 vectors at a time)
```

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/index` | X-Webhook-Secret | Queue content for indexing (202) |
| `POST` | `/extract-pdf` | X-Webhook-Secret | Fetch PDF from R2, extract, queue |
| `POST` | `/deindex` | X-Webhook-Secret | Remove all vectors for a lesson |
| `POST` | `/backfill` | X-Webhook-Secret | Re-index all ready videos |
| `GET` | `/status?lesson_id=&org_id=` | None | Indexed lesson count |
| `GET` | `/videos` | None | List Stream videos |
| `GET` | `/captions/:videoId` | None | Check captions status |
| `GET` | `/diag-index/:videoId/:title?...` | None | Dev: index a video |
| `GET` | `/diag-deindex/:lessonId` | None | Dev: deindex a lesson |
| `GET` | `/diag-text?content=...&...` | None | Dev: index text content |
| `GET` | `/diag-extract?key=...&preview=1` | None | Dev: extract text from R2 file |

## The Indexing Flow

### Video Lesson
```
LMS publishes lesson → POST /index
  {
    event: "publish",
    org_id: "org-123",
    entity: {
      id: "lesson-abc",
      title: "Intro to Python",
      contentType: "video",
      cloudflareVideoId: "abc123",
      streamStatus: "ready",
      course_id: "course-python",
      module_id: "mod-1",
      durationSeconds: 600
    }
  }

→ Queue consumer:
  1. Check streamStatus === "ready"
  2. Check for existing English captions on Stream
     a. If found: fetch VTT, extract text
     b. If not: generate AI captions → poll (20 × 3s) → fetch VTT
  3. Extract text from VTT:
     - Remove WEBVTT header, timestamps, cue numbers
     - Join remaining lines, normalize whitespace
  4. Chunk text at ~2000 chars (sentence boundaries)
  5. For each chunk:
     a. Embed via bge-large-en-v1.5 → 1024-dim vector
     b. Create metadata: title, lesson_id, course_id, module_id,
        org_id, content_type, source_type, chunk_index, total_chunks, content
  6. Batch upsert to Vectorize (10 at a time)
  7. Clean old vectors first: delete lesson-{id} + lesson-{id}-chunk0...19
```

### PDF/PPTX/Text Lesson
```
POST /extract-pdf { r2Key, lesson_id, title, org_id }
  or
POST /index with entity.content (text content)

→ Queue consumer:
  1. If PDF (.pdf):
     a. Fetch from R2 → ArrayBuffer
     b. Extract via unpdf: per-page text array
     c. Build RawChunk[] with page numbers
  2. If PPTX (.pptx/.ppt):
     a. Fetch from R2 → ArrayBuffer
     b. Parse ZIP → extract XML per slide
     c. Find <a:t> elements (slide text)
     d. Build RawChunk[] with slide numbers
  3. If Text (.txt/.md):
     a. Decode as UTF-8
     b. Wrap as single RawChunk
  4. Chunk content:
     - Structured: chunkContent(rawChunks, sourceType)
       - Each page/slide ≤ 2000 chars stays as one chunk
       - Larger pages/slides split at sentence boundaries
       - Preserves page_start/page_end/slide_number for citations
     - Legacy: chunkText(text) for flat content (videos)
  5. Embed + upsert same as video pipeline
```

### Deindex
```
POST /deindex { entity: { id: "lesson-abc" } }

→ Direct (not queued):
  1. Check for all chunk IDs: lesson-{id}, lesson-{id}-chunk0 through 19
     - Batch getByIds (20 IDs per batch, up to 3 batches = 60 chunks)
  2. Delete all found vectors
  3. Return { vectors_removed: N }
```

## VTT Extraction

```typescript
function extractTextFromVTT(vtt: string): string {
  return vtt
    .split("\n")
    .filter(line =>
      !line.startsWith("WEBVTT") &&     // skip header
      !line.match(/^\d{2}:/) &&          // skip timestamps
      !line.match(/^$/) &&               // skip blanks
      !line.match(/^\d+$/)              // skip cue numbers
    )
    .map(line => line.trim())
    .join(" ")
    .replace(/\s+/g, " ");
}
```

## Chunking

```typescript
const CHUNK_SIZE = 2000;  // chars per chunk

function findBreakpoint(text, start, end): number {
  // Prefer sentence boundary (". ") > newline > space
  const period = text.lastIndexOf(". ", end);
  const newline = text.lastIndexOf("\n", end);
  const space = text.lastIndexOf(" ", end);
  const breakpoint = Math.max(period, newline, space);
  return breakpoint > start + CHUNK_SIZE/2 ? breakpoint + 1 : end;
}
```

**Why 2000 chars?** Vectorize metadata limit is 10,240 bytes. Chunk text ≈ 2000 chars + metadata fields ≈ 200 chars = ~2.2KB per vector. Safe.

## Embedding + Upsert

```typescript
async function embedAndUpsert(env, org_id, entity, content, transcriptSource, structuredChunks?) {
  // 1. Clean old vectors (best-effort)
  // 2. Chunk content (structured if PDF/PPT, flat if video)
  // 3. For each chunk:
  //    a. env.AI.run("@cf/baai/bge-large-en-v1.5", { text: chunk.text })
  //    b. Extract vector (handle array, {data: [[...]]}, or bare)
  //    c. Build metadata with all fields + chunk index + page/slide
  // 4. Batch upsert: 10 vectors at a time (Vectorize max)
  // 5. Return { chunks, content_length }
}
```

**Vector ID scheme:**
- `lesson-{entity.id}` — legacy ID (pre-chunking, kept for backcompat)
- `lesson-{entity.id}-chunk0` — first chunk
- `lesson-{entity.id}-chunk1` — second chunk
- ... up to `lesson-{entity.id}-chunk59` (60 chunks = 120K chars max)

## Metadata Shape

```json
{
  "title": "Intro to Python",
  "lesson_id": "abc-123",
  "course_id": "course-python",
  "module_id": "mod-1",
  "org_id": "org-acme",
  "content_type": "pdf",
  "source_type": "pdf",
  "duration_seconds": 0,
  "transcript_source": "none",
  "chunk_index": 0,
  "total_chunks": 3,
  "content": "Python is a high-level programming language...",
  "page_start": 1,
  "page_end": 1
}
```

PDF/PPT files add `page_start`/`page_end` or `slide_number` for citation locations.

## Queue Configuration

```jsonc
// wrangler.jsonc
{
  "queues": {
    "consumers": [{
      "queue": "indexing-jobs",
      "max_batch_size": 3,
      "max_retries": 3,
      "max_concurrency": 1
    }]
  }
}
```

- Batch size 3: process up to 3 jobs concurrently
- Retry 3x: automatic retry on failure
- Timeout: 60s per batch (Workers CPU limit on paid plan)

## Fallback Path

If video captioning fails (no captions, generation timeout):
1. Build minimal content from entity metadata: `"${title}. ${type}. Duration: ${N}s."`
2. Embed + upsert that
3. Return `{ status: "fallback", transcript_source: "none" }`

This ensures every indexed lesson has at least something searchable.
