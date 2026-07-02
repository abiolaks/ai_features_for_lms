# AI01 Content Indexing — Code Walkthrough

> How the indexing pipeline works, why each decision was made, and how to explain it to someone else.

---

## What Problem Does This Solve?

The LMS stores course content as Cloudflare Stream videos. Those videos need to be searchable by the AI Tutor (AI04) and other features. AI01 bridges the gap:

```
LMS (video in Stream) ──→ AI01 Worker ──→ AI Search (searchable transcripts)
                                              ↑
                                         AI04 Tutor queries this
```

Without AI01, the Tutor would have no content to search — every answer would be "I don't know."

---

## File-by-File Breakdown

### 1. `src/index.ts` — The Worker (~280 lines)

#### Entry Point & Routing

```typescript
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET routes (diagnostic only)
    if (req.method === "GET" && path === "/videos")    → handleListVideos(env)
    if (req.method === "GET" && path.startsWith("/captions/")) → handleCheckCaptions(videoId, env)

    // All other routes: POST only
    if (req.method !== "POST") → 405

    // Parse JSON → 400 on failure
    switch (path) {
      case "/index":    → handleIndex(body, env)
      case "/deindex":  → handleDeindex(body, env)
      case "/backfill": → handleBackfill(body, env)
      default:          → 404
    }
  },
};
```

**Why GET routes exist:** Purely diagnostic. `/videos` lists all Stream videos. `/captions/:id` checks caption status + tries VTT fetch. These are not part of the API contract — they exist for debugging during development and can be removed or auth-gated later.

**Why POST-only for API routes:** These endpoints receive webhooks from the LMS. Webhooks are always POST.

---

#### `POST /index` — The Main Pipeline

This is where 80% of the logic lives:

```typescript
async function handleIndex(body, env): Promise<Response> {
  // Guard clauses
  if (!event)  → 400 "Missing event"
  if (!org_id) → 400 "Missing org_id"
  if (!entity) → 400 "Missing entity"
  if (event !== "publish") → 400 "Unknown event"

  // Branch: video vs text
  if (entity.contentType === "video") {
    return handleVideoIndex(entity, org_id, env);  // ← The complex path
  }

  // Text lesson: metadata-only upload
  const content = buildMetadataContent(entity);
  const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
  await instance.items.upload(`lesson-${entity.id}.json`, ...);
  return { status: "indexed", transcript_source: "none", content_length };
}
```

**Why metadata-only for text?** The LMS currently has no `content` field. All real content is in Stream video captions. Text lessons upload `{title}. {type}. Duration: Xs.` as placeholder content. When the LMS adds a `content` field later, we extend here.

**Why separate function for video?** The video path has 4 sub-steps (check, generate, poll, fetch). Keeping it in `handleVideoIndex` makes both paths readable without nested conditionals.

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
    const enCaption = captions.find(c => c.language === "en" && c.status === "ready");

    let transcript: string;
    let transcriptSource: string;

    if (enCaption) {
      // Step 3a: Captions exist → fetch VTT
      const vtt = await fetchStreamVTT(videoId, "en", env);
      transcript = extractTextFromVTT(vtt);
      transcriptSource = "existing";
    } else {
      // Step 3b: Generate captions → poll → fetch VTT
      await video.captions.generate("en");
      transcript = await pollForCaptions(videoId, video, env);
      transcriptSource = "ai_generated";
    }

    // Step 4: Upload to AI Search
    await instance.items.upload(...);

    return { status: "indexed", transcript_source, content_length };
  } catch (err) {
    // Fallback: metadata-only
    await instance.items.upload(metadataOnly);
    return { status: "fallback", error: err.message };
  }
}
```

**Why try/catch on the whole pipeline:** If caption generation fails (video has no audio, API error, timeout), we don't crash. We upload metadata-only content so the lesson is at least searchable by title. The Tutor works with degraded quality — better than "lesson not found."

**Why 202 for not-ready videos:** Videos go through Cloudflare Stream processing (pendingupload → queued → processing → ready). Until they're "ready," captions can't be generated. The 202 tells the caller "I acknowledge this, come back later." The `INDEXING_QUEUE` binding is provisioned for future async retry logic.

---

#### `pollForCaptions()` — The Waiting Game

```typescript
async function pollForCaptions(videoId, video, env): Promise<string> {
  const maxAttempts = 20;  // 20 × 3s = 60s max
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const captions = await video.captions.list();
    const ready = captions.find(c => c.status === "ready");
    if (ready) return extractTextFromVTT(await fetchStreamVTT(...));
    const errored = captions.find(c => c.status === "error");
    if (errored) throw new Error(...);
  }
  throw new Error("Caption generation timed out");
}
```

**Why 3-second intervals:** Stream's AI caption generation is fast for short videos (10–60s). Three seconds is enough to avoid hammering the API while still being responsive. The 60-second cap (20 attempts) covers even longer videos.

**Why check for errors mid-poll:** If the caption hits an error state, we stop polling immediately instead of waiting the full 60 seconds.

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

**Why needs two secrets:** `CLOUDFLARE_ACCOUNT_ID` builds the URL path. `CLOUDFLARE_STREAM_API_TOKEN` authenticates the request. Both were empty in early deploys — see `blockers-and-resolutions.md`.

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

**Why exported:** It's a pure function with no dependencies. Exporting it makes it testable in isolation (4 unit tests). Other Workers could import it, but currently only AI01 uses it.

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

This is what gets uploaded when:
1. The lesson is text-based (no video transcript)
2. Caption generation fails (fallback path)
3. Video is not ready yet (queued, metadata-only is uploaded separately)

---

#### `POST /deindex` — Cleanup

```typescript
async function handleDeindex(body, env): Promise<Response> {
  const { org_id, entity } = body;
  const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
  await instance.items.delete(`lesson-${entity.id}.json`);
  return { status: "deindexed" };
}
```

Simple: unpublish event → delete from AI Search. The key format `lesson-{id}.json` is consistent with indexing.

---

#### `POST /backfill` — Bulk Processing

```typescript
async function handleBackfill(body, env): Promise<Response> {
  const videos = await env.STREAM.videos.list();
  let queued = 0, skipped = 0;
  for (const video of videos) {
    if (video.status?.state === "ready") queued++;
    else skipped++;
  }
  return { status: "queued", queued, skipped };
}
```

**Purpose:** When onboarding a new org, list all their Stream videos and queue the ready ones for indexing. This avoids needing individual webhook events for each existing video.

**Currently counts only:** The actual queue submission (`INDEXING_QUEUE.send()`) is wired but not active yet — it will be added when the queue consumer Worker is built.

---

### 2. `wrangler.jsonc` — Bindings

```jsonc
{
  "stream": { "binding": "STREAM" },                    // env.STREAM.video(id).captions.list()
  "ai_search_namespaces": [{ "binding": "AI_SEARCH", "namespace": "lms-platform" }],
  "queues": { "producers": [{ "binding": "INDEXING_QUEUE", "queue": "indexing-jobs" }] }
}
```

| Binding | Gives us | Used for |
|---------|---------|----------|
| `STREAM` | Video listing, caption management | Check captions, generate new ones |
| `AI_SEARCH` | Instance get/upload/delete | Store transcripts, remove on unpublish |
| `INDEXING_QUEUE` | Message queue producer | Future: async retry for not-ready videos |

---

### 3. `test/index.test.ts` — 16 Tests

| Group | Tests | What it proves |
|-------|-------|---------------|
| Validation | 6 | 405 on GET, 404 on unknown, 400 on bad JSON/missing fields |
| VTT Parsing | 4 | extractTextFromVTT handles real VTT, empty, cue numbers, whitespace |
| Text indexing | 2 | Metadata upload works, correct AI Search instance used |
| Video indexing | 1 | Not-ready videos return 202 queued |
| Deindex | 1 | Delete calls correct instance + key |
| Backfill | 2 | Counts ready/skipped, rejects missing org_id |

**Why the full video pipeline isn't unit-tested:** Caption generation, polling, and VTT fetch require real Cloudflare Stream and REST API access. These are tested via integration (`wrangler dev` + real Stream video). The unit tests verify all code paths that CAN be tested locally.

**Mock strategy:** `env.STREAM` and `env.AI_SEARCH` are mocked with vitest mocks. The test wrangler config (`wrangler.test.jsonc`) omits the real bindings. This is the same pattern as AI03 (where `env.AI` is mocked).

---

## Architecture Decisions

### Why AI Search instance per org, not per lesson?

Three instances per org: `{org_id}-lessons`, `{org_id}-courses`, `{org_id}-assessments`. This creates physical isolation between orgs within the same namespace. The binding `env.AI_SEARCH.get("org-test-lessons")` can never accidentally return org-acme's data.

### Why metadata-only fallback instead of failing?

Degraded is better than broken. If caption generation fails, the lesson is still searchable by title. The Tutor can say "I found this lesson but don't have its full transcript" instead of "I couldn't find anything."

### Why REST API for VTT instead of Stream binding?

The Stream binding has no VTT-content-fetch method. The REST API requires secrets, which caused the main blocker during implementation (see `blockers-and-resolutions.md`). Once secrets are set, the REST API call is simple — a single `fetch()` with Bearer auth.

### Why generateToken approach failed?

We tried using `video.generateToken()` to create a signed URL for captions, but the signed URL pattern (`/{TOKEN}/captions/en/vtt`) returned 404. Cloudflare Stream's signed URLs work for manifests and playback but not for individual caption files. The REST API is the only reliable path.

---

## How to Explain This to Someone

> "AI01 is the content indexing pipeline. When the LMS publishes a course with video content, this Worker receives the webhook, fetches the video transcript from Cloudflare Stream, extracts the text, and uploads it to AI Search. That makes the content searchable — so the AI Tutor can actually answer questions about it.
>
> For text-based content, we upload metadata (title, type, duration) directly. For videos, we first check if captions already exist — many do, from Stream's auto-generation. If they don't, we generate new AI captions and poll until they're ready. Then we fetch the VTT file, strip out timestamps and formatting, and upload the clean text.
>
> If anything fails — video not ready, caption generation errors — we fall back to metadata-only. That way, the lesson is always findable, just with less precision until the full transcript processes."

---

## Common Questions & Answers

**Q: How long does caption generation take?**
A: Stream's AI caption generation is fast — typically under 30 seconds for short videos. We poll every 3 seconds for up to 60 seconds. Most videos have existing captions already (auto-generated on upload), so the "generate" path is rarely hit.

**Q: What happens if a video has no audio?**
A: Caption generation will fail. The error is caught, and we upload metadata-only content. The lesson is still indexed by title — just without transcript text.

**Q: How do new course uploads get indexed?**
A: The LMS sends a webhook on publish. Our Worker receives it, checks `streamStatus`, and either indexes immediately (if "ready") or returns 202 (if still processing). For backfills, the `/backfill` endpoint lists all Stream videos and queues them.

**Q: What cleanup happens when a course is deleted?**
A: LMS sends an unpublish webhook. Our `/deindex` endpoint removes the lesson from AI Search. No orphaned content.

**Q: How do we verify content is indexed correctly?**
A: Three ways:
1. `wrangler ai-search search org-test-lessons --namespace lms-platform --query "your topic"`
2. Cloudflare Dashboard → AI → AI Search → org-test-lessons → Search tab
3. `wrangler ai-search stats org-test-lessons` shows Queued/Processing/Indexed counts
