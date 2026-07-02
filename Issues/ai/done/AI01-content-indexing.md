# AI01: Content Indexing Pipeline

- **Type:** AFK
- **Week:** 2
- **Blocked by:** AI03 (LLM Gateway), LMS webhook support, AI Search instances provisioned, Cloudflare Stream API access
- **PR target:** ~200 lines

## What to build

A Cloudflare Worker that receives content publish events from the LMS, extracts transcripts from Cloudflare Stream videos, and uploads them to AI Search. **AI Search handles chunking, embedding, and indexing automatically.**

**Architecture:** LMS webhook → Worker fetches transcript from Stream → uploads to AI Search. Content is queryable within seconds-to-minutes (depending on caption generation time).

## The Real Data Shape

LMS lessons are video-based, not text-based:

```json
{
  "id": "019ef751...",
  "title": "Intro Video",
  "contentType": "video",
  "cloudflareVideoId": "69a5808380ae7cc1536b367b5f45a4aa",
  "streamStatus": "ready",
  "metadata": []
}
```

No `content` field. The actual content is the spoken audio in the Cloudflare Stream video. We extract it via Stream's AI captioning API.

## Content Extraction Strategy

### Primary Path: AI-Generated Transcript (best quality)

```
Video → Cloudflare Stream AI captioning → WebVTT transcript → clean text → AI Search
```

### Fallback Path: Metadata-Only (degraded but functional)

```
If caption generation fails or video has no audio:
  Video → title + duration + contentType → AI Search
```

The Tutor still works with metadata-only (answers will be less precise but not broken). AI06 (Learning Paths) and AI07 (Recommendations) don't need transcripts — they use course-level data.

## Endpoints

`POST /index` — body:
```json
{
  "event": "publish",
  "org_id": "org-wragby",
  "entity": {
    "id": "019ef751...",
    "title": "Intro Video",
    "contentType": "video",
    "cloudflareVideoId": "69a5808380ae7cc1536b367b5f45a4aa",
    "course_id": "019e216c...",
    "module_id": "019e5b08...",
    "durationSeconds": 57
  }
}
```

`POST /deindex` — body: `{ org_id, entity_id, entity_type }`

## Behavior

### On Publish (video lesson)

```typescript
// 1. Check if video is ready
if (entity.streamStatus !== "ready") {
  // Queue for retry or wait. Stream videos must be "ready" for captions.
  return { status: "queued", reason: "video_not_ready" };
}

// 2. Check existing captions
const video = env.STREAM.video(entity.cloudflareVideoId);
const captions = await video.captions.list();
const enCaption = captions.find(c => c.language === "en" && c.status === "ready");

let transcript = null;

if (enCaption) {
  // 3a. Captions already exist → fetch VTT directly
  const vtt = await fetchStreamVTT(entity.cloudflareVideoId, "en", env);
  transcript = extractTextFromVTT(vtt);
} else {
  // 3b. Generate captions via AI
  await video.captions.generate("en");
  await pollUntilReady(video, "en");  // Usually < 30s for short videos
  const vtt = await fetchStreamVTT(entity.cloudflareVideoId, "en", env);
  transcript = extractTextFromVTT(vtt);
}

// 4. Upload transcript to AI Searchso thwhe
const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
await instance.items.upload(`lesson-${entity.id}.json`, JSON.stringify({
  content: transcript,
  metadata: {
    title: entity.title,
    lesson_id: entity.id,
    course_id: entity.course_id,
    module_id: entity.module_id,
    org_id: org_id,
    content_type: "video",
    duration_seconds: entity.durationSeconds,
    transcript_source: enCaption ? "existing" : "ai_generated",
  }
}));
```

### On Publish (non-video or caption failure)

```typescript
// Fallback: upload metadata-only
const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
await instance.items.upload(`lesson-${entity.id}.json`, JSON.stringify({
  content: `${entity.title}. ${entity.contentType || "lesson"}. Duration: ${entity.durationSeconds}s.`,
  metadata: {
    title: entity.title,
    lesson_id: entity.id,
    course_id: entity.course_id,
    module_id: entity.module_id,
    org_id: org_id,
    content_type: entity.contentType || "unknown",
    transcript_source: "none",
  }
}));
```

### On Unpublish

```typescript
await instance.items.delete(`lesson-${entity.id}.json`);
```

### On Update

Re-runs the publish flow (AI Search replaces previous version automatically).

## VTT Extraction

Cloudflare Stream returns WebVTT format:

```
WEBVTT

00:00:00.000 --> 00:00:05.240
Welcome to Python fundamentals. Today we're going to cover

00:00:05.240 --> 00:00:12.800
variables, data types, and how to write your first function.
```

We extract clean text:

```typescript
function extractTextFromVTT(vtt: string): string {
  return vtt
    .split("\n")
    .filter(line =>
      !line.startsWith("WEBVTT") &&
      !line.match(/^\d{2}:/) &&    // skip timestamps
      !line.match(/^$/) &&           // skip blank lines
      !line.match(/^\d+$/)           // skip cue numbers
    )
    .map(line => line.trim())
    .join(" ")
    .replace(/\s+/g, " ");           // normalize whitespace
}
```

## Wrangler Configuration

```toml
# wrangler.toml
name = "ai-indexing"
main = "src/index.ts"

[[ai_search_namespaces]]
binding = "AI_SEARCH"
namespace = "lms-platform"

[[stream]]              # ← NEW: for caption generation + VTT fetch
binding = "STREAM"
```

### Secrets

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN    # Stream API access
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID   # For Stream REST API calls
npx wrangler secret put LMS_WEBHOOK_SECRET      # Verify webhook authenticity
```

## Multi-Tenant Architecture

```
AI Search Namespace: lms-platform
  ├── org-wragby-courses       (course titles, descriptions, metadata)
  ├── org-wragby-lessons       (video transcripts, lesson metadata)
  ├── org-wragby-assessments   (quiz questions, rubrics, criteria)
  ├── org-acme-courses
  ├── org-acme-lessons
  └── org-acme-assessments
```

Three instances per org. Physical isolation — Org A's Worker binding cannot reach Org B's instances.

## What We DON'T Build

- ❌ No chunking logic (AI Search auto-chunks)
- ❌ No embedding calls (AI Search auto-embeds)
- ❌ No Vectorize (AI Search is the retrieval engine)
- ❌ No manual transcript creation (Stream AI generates captions)
- ❌ No audio download + external STT (Stream handles it natively)

## AI Search Instance Configuration

```typescript
await env.AI_SEARCH.create({
  id: `${org_id}-lessons`,
  index_method: { vector: true, keyword: true },
  fusion_method: "rrf",
  chunk_size: 512,
  chunk_overlap: 64,
  reranking: true,
  reranking_model: "@cf/baai/bge-reranker-base",
  cache: true,
  cache_ttl: 86400,
  custom_metadata: [
    { field_name: "title", data_type: "text" },
    { field_name: "lesson_id", data_type: "text" },
    { field_name: "course_id", data_type: "text" },
    { field_name: "module_id", data_type: "text" },
    { field_name: "org_id", data_type: "text" },
    { field_name: "content_type", data_type: "text" },
    { field_name: "duration_seconds", data_type: "number" },
    { field_name: "transcript_source", data_type: "text" },
  ],
});
```

## Acceptance Criteria

- [ ] Publish event for video → captions generated → transcript uploaded → queryable in AI Search
- [ ] Video with existing captions → captions reused (no re-generation)
- [ ] Caption generation fails → metadata-only fallback uploaded
- [ ] Unpublish event → lesson removed from AI Search
- [ ] Update event → transcript re-fetched + re-uploaded (AI Search replaces previous)
- [ ] Org isolation: Org A content only in org-a instances
- [ ] Metadata (title, course_id, lesson_id, content_type) filterable in AI Search
- [ ] Unit tests: VTT parsing, caption status polling, fallback path, webhook validation
- [ ] **Observability:** Caption generation span shows video_id, language, status, duration
- [ ] **Observability:** Upload span shows instance, transcript length, source (existing/ai_generated/none)
- [ ] **Observability:** Webhook event type tracked (`event.type: publish|unpublish|update`)

## Cost Note

Cloudflare Stream AI caption generation costs **$0.10 per minute** of video. A 10-minute course video = $1.00. This is a one-time cost per video (captions are stored, not regenerated on update unless the video content changes).

## What Changed From Original Plan

| Before (Path A) | After (Path B + Stream) |
|-----------------|------------------------|
| Assumed text from `lesson.content` | Extract transcripts from Cloudflare Stream video |
| Manual chunking (~80 lines) | AI Search auto-chunks |
| Workers AI bge-m3 embedding calls | AI Search auto-embeds |
| Vectorize upsert + metadata management | AI Search Items API upload |
| No video/audio handling | Stream AI captioning + VTT parsing |
| ~350 lines | ~200 lines |
