# AI01 Content Indexing — Code Walkthrough

> How the indexing pipeline works, why each decision was made, and how to explain it to someone else.

---

## What Problem Does This Solve?

The LMS stores course content as Cloudflare Stream videos and R2 documents. That content needs to be searchable by the AI Tutor (AI04) and other AI features. AI01 bridges the gap:

```
LMS (video in Stream / PDF in R2)
         │
         ▼
   AI01 Worker
         │
    ┌────┴────┐
    │         │
Captions    PDF
from Stream  from R2
    │         │
    └────┬────┘
         ▼
  Workers AI embedding
  (@cf/baai/bge-large-en-v1.5)
         │
         ▼
    Vectorize
  (semantic search)
         │
         ▼
  AI04 Tutor queries this
```

Without AI01, the Tutor would have no content to search — every answer would be "I don't know."

---

## File-by-File Breakdown

### 1. `src/index.ts` — The Worker (~550 lines)

#### Entry Point & Routing

```typescript
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET routes (diagnostic only)
    if (req.method === "GET" && path === "/videos")        → handleListVideos(env)
    if (req.method === "GET" && path.startsWith("/captions/")) → handleCheckCaptions(videoId, env)
    if (req.method === "GET" && path.startsWith("/diag-index/")) → handleDiagIndex(...)
    if (req.method === "GET" && path.startsWith("/diag-deindex/")) → handleDiagDeindex(...)
    if (req.method === "GET" && path === "/diag-extract")  → handleDiagExtract(url, env)
    if (req.method === "GET" && path === "/r2-list")       → handleR2List(url, env)
    if (req.method === "GET" && path === "/env-check")     → handleEnvCheck(env)

    // All other endpoints: POST only
    if (req.method !== "POST") → 405

    // ── Webhook auth ──
    // Validate X-Webhook-Secret header against env.LMS_WEBHOOK_SECRET
    // Returns 401 on mismatch / missing

    // Parse JSON → 400 on failure
    switch (path) {
      case "/index":       → queue job, return 202
      case "/extract-pdf": → fetch from R2, extract, queue
      case "/deindex":     → handleDeindex(body, env)
      case "/backfill":    → handleBackfill(body, env)
      default:             → 404
    }
  },

  // ── Queue consumer ──
  async queue(batch: MessageBatch<IndexJob>, env: Env): Promise<void> {
    // Processes index jobs asynchronously
    // Calls handleIndex() for each message
    // On failure: msg.retry({ delaySeconds: 5-10 })
    // On success: msg.ack()
  },
};
```

**Why GET routes exist:** Purely diagnostic. `/videos` lists Stream videos. `/captions/:id` checks caption status. `/diag-index/:videoId/:title` runs the full index pipeline for a single video. `/diag-deindex/:lessonId` removes all vectors. `/diag-extract` tests PDF extraction. `/r2-list` browses R2 objects. `/env-check` shows which env vars are set (without values). These are not part of the API contract — they exist for debugging during development.

**Why webhook auth on POST routes:** All mutation endpoints (`/index`, `/deindex`, `/backfill`, `/extract-pdf`) require `X-Webhook-Secret` matching `LMS_WEBHOOK_SECRET`. This prevents unauthorized indexing. The secret is set via `npx wrangler secret put LMS_WEBHOOK_SECRET`.

**Why POST-only for API routes:** These endpoints receive webhooks from the LMS. Webhooks are always POST.

---

#### `POST /index` — Queue, Don't Block

The `/index` endpoint **no longer processes synchronously**. Instead, it validates the payload, pushes it to `INDEXING_QUEUE`, and returns 202 immediately:

```typescript
async function handleIndex(body: IndexRequest, env: Env): Promise<Response> {
  // 1. Enrich entity metadata from LMS (best-effort)
  const enrichedEntity = await enrichFromLms(entity, env);

  // 2. Guard clauses
  if (!event)  → 400 "Missing event"
  if (!org_id) → 400 "Missing org_id"
  if (!entity) → 400 "Missing entity"
  if (event !== "publish") → 400 "Unknown event"

  // 3. Branch: video vs text
  if (enrichedEntity.contentType === "video") {
    return handleVideoIndex(enrichedEntity, org_id, env);
  }

  // 4. Text lesson: embed + upsert
  const content = enrichedEntity.content || buildMetadataContent(enrichedEntity);
  const { chunks, content_length } = await embedAndUpsert(env, org_id, enrichedEntity, content, "none");
  return { status: "indexed", transcript_source: "none", content_length, chunks };
}
```

**Wait — the queue is used from the `fetch()` handler, but `handleIndex` is called both from `queue()` and `handleDiagIndex`. Why?** The queue consumer calls `handleIndex` directly for async processing. But the `/index` POST endpoint **also** calls `env.INDEXING_QUEUE.send(body)` from `fetch()` before returning 202 — the consumer picks it up and calls `handleIndex`. The diagnostic `/diag-index` GET endpoint calls `handleIndex` synchronously (no queue) so you get immediate results during development.

**LMS enrichment:** Before indexing, `handleIndex` fetches lesson metadata from the LMS API (`/api/v1/lessons/{id}`) via `fetchLms()`. This enriches `title`, `description`, and `tags` in the Vectorize metadata. If the LMS is unreachable, it falls back to data from the webhook body.

---

#### `handleVideoIndex()` — The Video Pipeline

```typescript
async function handleVideoIndex(entity, org_id, env): Promise<Response> {
  // Step 1: Gate on streamStatus
  if (entity.streamStatus !== "ready") {
    return { status: "queued", reason: "video_not_ready" };  // 202
  }

  try {
    // Step 2: Check existing captions
    const video = env.STREAM.video(videoId);
    const captions = await video.captions.list();
    const enCaption = captions.find(c =>
      (c.language === "en" || c.language === "eng") && c.status === "ready"
    );

    let transcript: string;
    let transcriptSource: string;

    if (enCaption) {
      // Step 3a: Captions exist → fetch VTT
      const vtt = await fetchStreamVTT(videoId, enCaption.language, env);
      transcript = extractTextFromVTT(vtt);
      transcriptSource = "existing";
    } else {
      // Step 3b: Generate captions → poll → fetch VTT
      await video.captions.generate("en");
      transcript = await pollForCaptions(videoId, video, env);
      transcriptSource = "ai_generated";
    }

    // Step 4: Embed + upsert to Vectorize (chunked if needed)
    const { chunks, content_length } = await embedAndUpsert(
      env, org_id, entity, transcript, transcriptSource
    );

    return { status: "indexed", transcript_source, content_length, chunks };
  } catch (err) {
    // Fallback: metadata-only embed + upsert
    const content = buildMetadataContent(entity);
    await embedAndUpsert(env, org_id, entity, content, "none");
    return { status: "fallback", error: err.message };
  }
}
```

**Why try/catch on the whole pipeline:** If caption generation fails (video has no audio, API error, timeout), we don't crash. We embed and upsert metadata-only content so the lesson is at least searchable by title. The Tutor works with degraded quality — better than "lesson not found."

**Why 202 for not-ready videos:** Videos go through Cloudflare Stream processing (pendingupload → queued → processing → ready). Until they're "ready," captions can't be generated. The 202 tells the caller "I acknowledge this, come back later."

---

#### `embedAndUpsert()` — The Core (Embedding + Vectorize)

This is the heart of the pipeline. Instead of uploading raw text to AI Search (which auto-chunks/embeds), **we generate embeddings ourselves** with Workers AI and upsert directly into Vectorize:

```typescript
async function embedAndUpsert(env, org_id, entity, content, transcriptSource) {
  // 0. Clean up old vectors (best-effort)
  // Delete all previous chunk IDs: lesson-{id}, lesson-{id}-chunk0, ...

  // 1. Chunk the content
  const chunks = chunkText(content);  // ~2000 chars each

  // 2. Generate embeddings for each chunk
  const vectors = [];
  for (const chunk of chunks) {
    const result = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: chunk });
    vectors.push({
      id: `lesson-${entity.id}-chunk${i}`,
      values: result.data[0],  // 1024-dim vector
      metadata: {
        title, lesson_id, course_id, module_id, org_id,
        content_type, duration_seconds, transcript_source,
        chunk_index, total_chunks, content: chunk,
      },
    });
  }

  // 3. Upsert in batches of 10 (Vectorize limit)
  for (let i = 0; i < vectors.length; i += 10) {
    await env.VECTORIZE_INDEX.upsert(vectors.slice(i, i + 10));
  }
}
```

**Why embed ourselves instead of using AI Search auto-chunk/embed?** We use Vectorize directly with `@cf/baai/bge-large-en-v1.5` (1024-dim embeddings) for full control over chunking strategy, metadata structure, and org isolation. This also means querying (in AI04) uses `VECTORIZE_INDEX.query()` with the same embedding model — no impedance mismatch.

**Why bge-large-en-v1.5?** It's a state-of-the-art English embedding model available on Workers AI. 1024 dimensions gives better accuracy than smaller models (like 384-dim `bge-small`). It runs on Cloudflare's GPU infrastructure with no cold start penalty.

---

#### `chunkText()` — Smart Chunking

```typescript
const CHUNK_SIZE = 2000;  // chars per chunk

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + CHUNK_SIZE;
    // Try to break at a sentence boundary (. ), newline, or space
    if (end < text.length) {
      const period = text.lastIndexOf(". ", end);
      const newline = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const breakpoint = Math.max(period, newline, space);
      if (breakpoint > start + CHUNK_SIZE / 2) {
        end = breakpoint + 1;
      }
    }
    chunks.push(text.substring(start, end).trim());
    start = end;
  }
  return chunks;
}
```

**Why chunk at 2000 chars:** Vectorize has a metadata limit of 10,240 bytes. Long transcripts (20+ minute videos) easily exceed this. Each chunk stores ~2000 chars of content in metadata, plus ~200 chars of field overhead = ~2.2KB — well within the limit. Each chunk gets its own embedding vector and metadata, and querying returns individual chunks which the Tutor can stitch together.

**Why sentence-boundary splitting:** Breaking at sentence boundaries (`. `, newlines) produces more coherent chunks than chopping mid-sentence. This improves retrieval quality — the Tutor gets meaningful snippets, not truncated fragments.

**Why minimum 50% threshold:** If we can't find a good breakpoint past the midpoint of the chunk, we use the full 2000 chars. This prevents tiny leftovers at the end.

---

#### `pollForCaptions()` — The Waiting Game

```typescript
async function pollForCaptions(videoId, video, env): Promise<string> {
  const maxAttempts = 20;  // 20 × 3s = 60s max
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const captions = await video.captions.list();
    const ready = captions.find(c =>
      (c.language === "en" || c.language === "eng") && c.status === "ready"
    );
    if (ready) return extractTextFromVTT(await fetchStreamVTT(...));
    const errored = captions.find(c => c.status === "error");
    if (errored) throw new Error(...);
  }
  throw new Error("Caption generation timed out");
}
```

**Why 3-second intervals:** Stream's AI caption generation is fast for short videos (10–60s). Three seconds is enough to avoid hammering the API while still being responsive. The 60-second cap (20 attempts) covers even longer videos.

**Why check for errors mid-poll:** If the caption hits an error state, we stop polling immediately instead of waiting the full 60 seconds.

**Why match both "en" and "eng":** Stream's caption API may return language codes as either two-letter (`en`) or three-letter (`eng`). We match both.

---

#### `fetchStreamVTT()` — The REST API Bridge

```typescript
async function fetchStreamVTT(videoId, language, env): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${videoId}/captions/${language}/vtt`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
  });
  return resp.text();
}
```

**Why REST API instead of Stream binding:** The Stream binding has `captions.list()`, `captions.generate()`, `captions.upload()`, `captions.delete()` — but NO method to read the VTT content. This is a gap in the binding API. We bridge it with the REST API.

**Why needs two secrets:** `CLOUDFLARE_ACCOUNT_ID` builds the URL path. `CLOUDFLARE_STREAM_API_TOKEN` authenticates the request.

---

#### `extractTextFromVTT()` — The Parser

```typescript
export function extractTextFromVTT(vtt: string): string {
  return vtt
    .split("\n")
    .filter(line =>
      !line.startsWith("WEBVTT") &&   // Skip header
      !line.match(/^\d{2}:/) &&       // Skip timestamps
      !line.match(/^$/) &&            // Skip blank lines
      !line.match(/^\d+$/)            // Skip cue numbers
    )
    .map(line => line.trim())
    .join(" ")
    .replace(/\s+/g, " ");            // Normalize whitespace
}
```

**Input (WebVTT):**
```
WEBVTT

00:00:00.000 --> 00:00:05.240
Welcome to Python fundamentals.

00:00:05.240 --> 00:00:12.800
Today we'll cover variables and data types.
```

**Output:** `"Welcome to Python fundamentals. Today we'll cover variables and data types."`

**Why exported:** It's a pure function with no dependencies. Exporting it makes it testable in isolation (4 unit tests).

---

#### `POST /extract-pdf` — Document Processing

```typescript
async function handleExtractPdf(body, env): Promise<Response> {
  // 1. Fetch from R2
  const pdfObj = await env.LMS_CONTENT.get(body.r2Key);

  // 2. Extract text based on file type
  if (key.endsWith(".pdf"))  → extractTextFromPdfBufferAsync (unpdf) + regex fallback
  if (key.endsWith(".pptx")) → extractTextFromPptxBuffer (XML <a:t> elements)
  if (key.endsWith(".txt") || ".md") → decode as UTF-8
  else → try plain text

  // 3. Queue for indexing (same pipeline as videos)
  await env.INDEXING_QUEUE.send({
    event: "publish",
    org_id: body.org_id,
    entity: { id, title, contentType: "pdf", content: fullText, ... },
  });

  return { status: "queued", chars: fullText.length };
}
```

**Why R2 instead of Stream:** PDFs, PPTXs, and text documents are stored in R2 (not Stream). The LMS uploads course materials to `lms-content-staging` bucket. This endpoint extracts text and sends it through the same indexing pipeline as video transcripts.

**Why unpdf + regex fallback for PDFs:** `unpdf` is a Workers-compatible PDF extraction library that handles compressed PDFs. But some PDFs use older compression formats or have embedded fonts that unpdf can't handle. The regex fallback looks for `(text) Tj` patterns in uncompressed PDFs — these are plain text drawing operations. Between both strategies, we catch most PDFs.

**PPTX extraction strategy:** PPTX files are ZIP archives containing XML. Slide text lives in `<a:t>` elements (the `a:` namespace is for DrawingML text). The regex `/<a:t[^>]*>([^<]*)<\/a:t>/g` extracts all text fragments. No library needed.

**Why 422 for no extractable text:** Some PDFs are scanned images (needs OCR) or contain only vector graphics. The 422 with `error: "no_extractable_text"` tells the caller to pre-extract with PyPDF2 and send text via `entity.content` in the `/index` endpoint.

---

#### `POST /deindex` — Cleanup with Batch Deletion

```typescript
async function handleDeindex(body, env): Promise<Response> {
  const { entity } = body;
  // Delete all chunked vectors: lesson-{id}, lesson-{id}-chunk0, ..., lesson-{id}-chunkN
  // getByIds has a 20-ID limit, so batch in groups of 20
  for (let batch = 0; batch < 3; batch++) {
    const ids = Array.from({ length: 20 }, (_, i) => {
      const chunkIdx = batch * 20 + i;
      return chunkIdx === 0
        ? `lesson-${entity.id}`
        : `lesson-${entity.id}-chunk${chunkIdx - 1}`;
    });
    const existing = await env.VECTORIZE_INDEX.getByIds(ids);
    const toDelete = existing.filter(v => v !== null).map(v => v.id);
    if (toDelete.length > 0) {
      await env.VECTORIZE_INDEX.deleteByIds(toDelete);
    }
  }
}
```

**Why 3 batches of 20:** Vectorize's `getByIds` and `deleteByIds` have a 20-ID limit. A heavily-chunked video could have 30+ vectors. Three batches of 20 covers up to 60 chunks — enough for a 2-hour video. The ID scheme generates `lesson-{id}` for chunk 0, then `lesson-{id}-chunk0` through `lesson-{id}-chunkN`, so we need batch 0 to try the non-chunked ID and batch 1 to try chunk indices 0–18 etc.

**Why getByIds first:** We only delete vectors that actually exist, avoiding unnecessary API calls and errors. The response includes `vectors_removed` count for observability.

---

#### `POST /backfill` — Bulk Processing

```typescript
async function handleBackfill(body, env): Promise<Response> {
  const videos = await env.STREAM.videos.list();
  let queued = 0, skipped = 0;
  for (const video of videos) {
    if (video.status?.state !== "ready") { skipped++; continue; }
    await env.INDEXING_QUEUE.send({
      event: "publish",
      org_id: body.org_id,
      entity: {
        id: video.uid || video.id,
        title: video.meta?.name || "Untitled",
        contentType: "video",
        cloudflareVideoId: video.uid || video.id,
        streamStatus: "ready",
        durationSeconds: Math.round(video.duration || 0),
      },
    });
    queued++;
  }
  return Response.json({ status: "queued", queued, skipped });
}
```

**Purpose:** When onboarding a new org or recovering from a data loss, list all Stream videos and queue the ready ones for indexing. Each video becomes a separate queue message, processed asynchronously by the queue consumer.

**Why per-video queue messages:** Not a single batch job. Each video can take 3–60 seconds depending on caption generation. Queue messages process independently, so one slow caption doesn't block others.

---

#### `buildMetadataContent()` — Fallback Content

```typescript
function buildMetadataContent(entity): string {
  const type = entity.contentType || "lesson";
  const duration = entity.durationSeconds ? `Duration: ${entity.durationSeconds}s.` : "";
  return `${entity.title}. ${type}. ${duration}`.trim().replace(/\s+/g, " ");
}
```

**Example:** `"Lumera Unit 1. video. Duration: 57s."` (44 chars)

This is what gets embedded and upserted when:
1. The lesson is text-based (no video transcript)
2. Caption generation fails (fallback path)

Note: unlike the old AI Search approach (which only uploaded metadata), **metadata-only content is still embedded as a vector**. This means it's searchable by semantic similarity — the Tutor can find it even with paraphrased queries.

---

### 2. `wrangler.jsonc` — Bindings

```jsonc
{
  "ai": { "binding": "AI" },           // env.AI.run("@cf/baai/bge-large-en-v1.5", ...)
  "stream": { "binding": "STREAM" },   // env.STREAM.video(id).captions.list()
  "r2_buckets": [{                     // env.LMS_CONTENT.get(key)
    "binding": "LMS_CONTENT",
    "bucket_name": "lms-content-staging"
  }],
  "vectorize": [{                      // env.VECTORIZE_INDEX.upsert(...)
    "binding": "VECTORIZE_INDEX",
    "index_name": "lms-lessons"
  }],
  "queues": {
    "producers": [{                    // env.INDEXING_QUEUE.send(...)
      "binding": "INDEXING_QUEUE",
      "queue": "indexing-jobs"
    }],
    "consumers": [{                    // queue() handler
      "queue": "indexing-jobs",
      "max_batch_size": 3,
      "max_batch_timeout": 60
    }]
  }
}
```

| Binding | Gives us | Used for |
|---------|---------|----------|
| `AI` | Workers AI model inference | Generate embeddings with `bge-large-en-v1.5` |
| `STREAM` | Video listing, caption management | Check captions, generate new ones |
| `LMS_CONTENT` | R2 object storage | Fetch PDFs, PPTXs, TXTs for extraction |
| `VECTORIZE_INDEX` | Vector database (upsert, query, delete) | Store embedded transcripts + metadata |
| `INDEXING_QUEUE` | Async message queue (producer + consumer) | Queue index jobs, process in `queue()` handler |

**Secrets (set via `npx wrangler secret put`):**
| Secret | Used by |
|--------|---------|
| `CLOUDFLARE_STREAM_API_TOKEN` | `fetchStreamVTT()` — REST API auth |
| `CLOUDFLARE_ACCOUNT_ID` | `fetchStreamVTT()` — URL path |
| `LMS_WEBHOOK_SECRET` | Webhook auth header validation |
| `LMS_GATEWAY_URL` | `fetchLms()` — LMS API base URL |
| `LMS_INTERNAL_KEY` | `fetchLms()` — LMS API auth |

---

### 3. `test/index.test.ts` — 17 Tests

| Group | Tests | What it proves |
|-------|-------|---------------|
| Validation | 8 | 405 on GET, 401 on missing/wrong webhook secret, 404 on unknown, 400 on bad JSON/missing fields |
| VTT Parsing | 4 | extractTextFromVTT handles real VTT, empty, cue numbers, whitespace |
| Text indexing | 1 | Text content is queued for indexing (returns 202) |
| Video indexing | 1 | Not-ready videos return 202 queued |
| Deindex | 1 | Delete calls Vectorize getByIds + deleteByIds |
| Backfill | 2 | Counts ready/skipped, rejects missing org_id |

**Why the full video pipeline isn't unit-tested:** Caption generation, polling, VTT fetch, embedding, and Vectorize upsert require real Cloudflare bindings. These are tested via integration (`wrangler dev` + real Stream video) using the diagnostic endpoints.

**Mock strategy:** `env.STREAM`, `env.AI`, and `env.VECTORIZE_INDEX` are mocked with vitest mocks. `env.AI.run()` returns a mock 384-dim embedding vector. `env.VECTORIZE_INDEX.upsert()` and `deleteByIds()` are no-ops. The test wrangler config (`wrangler.test.jsonc`) omits the real bindings.

---

## Architecture Decisions

### Why Vectorize directly (not AI Search)?

AI Search is a higher-level service that auto-chunks, embeds, and stores. We need more control:

1. **Custom chunking:** AI Search chunks at ~512 tokens. We chunk at ~2000 chars with sentence-boundary awareness. Our chunks are more coherent for educational content (whole paragraphs vs sentence fragments).
2. **Metadata flexibility:** We store `org_id`, `course_id`, `module_id`, `chunk_index`, `total_chunks`, `transcript_source` in every vector. This enables filtered queries (by course, by module) and provenance tracking.
3. **Consistent embeddings:** We use `bge-large-en-v1.5` (1024-dim) for both indexing and querying. AI Search uses `qwen3-embedding-0.6b` (384-dim) internally — using the same model everywhere avoids query/index embedding mismatch.
4. **Single Vectorize index:** One `lms-lessons` index with `org_id` metadata filtering, instead of per-org AI Search instances. Simpler to manage, query, and back up.

### Why queue-based async processing?

The `/index` endpoint pushes to `INDEXING_QUEUE` and returns 202 immediately. The queue consumer (`queue()` handler) processes each job:

- **Caption generation** can take 30–60 seconds. Blocking the HTTP response is bad UX.
- **Embedding generation** calls Workers AI — also non-trivial latency.
- **Retry logic:** If caption generation fails, `msg.retry({ delaySeconds: 5 })` retries. After several failures, the dead letter queue catches it.
- **Backpressure:** `max_batch_size: 3` prevents overwhelming Workers AI with concurrent embedding requests.

### Why embed metadata-only fallback?

Even when caption generation fails, we embed the metadata string (`"Title. video. Duration: 57s."`) as a vector. This means:
- The lesson is still findable via semantic search (title-based)
- The Tutor can say "I found this lesson but don't have its full transcript" instead of "nothing found"
- Degraded is better than broken

### Why REST API for VTT instead of Stream binding?

The Stream binding has no VTT-content-fetch method. The REST API requires secrets, which caused the main blocker during implementation (see `blockers-and-resolutions.md`). Once secrets are set, the REST API call is simple — a single `fetch()` with Bearer auth.

### Why orphan cleanup before upsert?

Before upserting new vectors, `embedAndUpsert()` deletes any existing vectors with the same `lesson-{id}` prefix. This handles:
- **Re-indexing:** Same lesson, updated transcript
- **Chunk count changes:** Old version had 3 chunks, new version has 5
- **ID format migration:** Old non-chunked IDs (`lesson-{id}`) get cleaned up

---

## How to Explain This to Someone

> "AI01 is the content indexing pipeline. When the LMS publishes a course, this Worker receives the webhook, extracts the content, generates embeddings using Workers AI, and stores them in Vectorize for semantic search.
>
> For videos, we fetch captions from Cloudflare Stream — either existing ones or AI-generated ones — then extract clean text from the WebVTT format. For documents (PDFs, PPTXs, text files), we fetch from R2 and extract text using libraries and regex fallbacks.
>
> The extracted text gets split into ~2000-character chunks at sentence boundaries. Each chunk is embedded with `bge-large-en-v1.5` (1024-dim vectors) and upserted to Vectorize with rich metadata: title, course, module, org, chunk position. This chunked, embedded format means the AI Tutor can search by meaning, not just keyword matching.
>
> Processing is asynchronous via Cloudflare Queues. The webhook endpoint accepts the job and returns 202 immediately. A queue consumer picks it up, runs the full pipeline (caption extraction → chunking → embedding → upsert), and retries on failure.
>
> If anything fails — video not ready, caption generation errors, PDF extraction failure — we fall back to metadata-only embedding. The lesson is always findable, just with less precision until the full content processes."

---

## Common Questions & Answers

**Q: How long does caption generation take?**
A: Stream's AI caption generation is fast — typically under 30 seconds for short videos. We poll every 3 seconds for up to 60 seconds. Most videos have existing captions already (auto-generated on upload), so the "generate" path is rarely hit.

**Q: What happens if a video has no audio?**
A: Caption generation will fail. The error is caught, and we fall back to metadata-only embedding. The lesson is still searchable by title.

**Q: How do new course uploads get indexed?**
A: The LMS sends a webhook on publish. Our Worker validates the webhook secret, queues the job, and returns 202. The queue consumer processes it asynchronously. For backfills, the `/backfill` endpoint lists all Stream videos and queues them.

**Q: What cleanup happens when a course is deleted?**
A: LMS sends an unpublish webhook. Our `/deindex` endpoint retrieves all chunk IDs (batches of 20), checks which exist, and deletes them from Vectorize. Returns count of vectors removed.

**Q: How do we verify content is indexed correctly?**
A: Several ways:
1. `wrangler vectorize get-by-ids lms-lessons --ids '["lesson-{id}-chunk0"]'` — check individual vectors
2. `GET /diag-index/:videoId/:title?org_id=...` — run full pipeline synchronously and see result
3. `GET /diag-deindex/:lessonId` — remove all vectors for cleanup
4. `GET /env-check` — verify secrets and bindings are configured
5. AI04 Tutor query — semantic search for lesson content

**Q: Why chunk at 2000 chars rather than tokens?**
A: Vectorize's metadata limit is 10,240 bytes, not a token count. Character counting is deterministic and simpler. 2000 chars of English text ≈ 300–400 tokens — a good chunk size for educational content.

**Q: Can I index a PDF without going through the LMS webhook?**
A: Yes — use `GET /diag-extract?key=path/to/file.pdf&title=My+Title&org_id=org-test&preview=1` to test extraction, then `POST /extract-pdf` with `{ r2Key, lesson_id, title, org_id }` to queue for indexing. This works independently of LMS webhooks.
