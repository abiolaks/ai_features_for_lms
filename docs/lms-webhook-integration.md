# AI Content Indexing — LMS Webhook Integration Guide

> For LMS Engineers: How to integrate content publishing with the AI indexing pipeline.

---

## Overview

When the LMS publishes, updates, or removes content, it must notify the AI indexing worker so the AI tutor can answer questions about that content. This is done via **webhooks** — simple HTTP POST calls from the LMS backend to the indexing worker.

```
┌──────────┐     publish event      ┌──────────────────┐
│   LMS    │ ───────────────────────→│  AI Indexing     │
│ Backend  │   POST /index           │  Worker          │
│          │                         │  (Cloudflare)    │
│          │                         │                  │
│          │                         │  Extract text    │
│          │                         │  → Chunk         │
│          │                         │  → Embed         │
│          │                         │  → Store         │
│          │                         │                  │
│          │                         │  ┌─────────────┐ │
│          │                         │  │  Vectorize   │ │
│          │                         │  │  (searchable)│ │
│          │                         │  └─────────────┘ │
│          │                         └──────────────────┘
│          │                                  │
│          │                          ┌───────┴───────┐
│  Learner │  "What is AI?"           │  AI Tutor     │
│ ─────────┼─────────────────────────→│  queries      │
│          │   answer + citations     │  Vectorize    │
│          │←─────────────────────────│  → answer     │
└──────────┘                          └───────────────┘
```

**Without webhooks:** Content exists in the LMS but is invisible to the AI tutor. Learners get "I couldn't find that" or "The AI tutor is preparing for this lesson."

**With webhooks:** Content is searchable within 30-60 seconds of publishing.

---

## Endpoints

| Action | Method | URL | Auth |
|--------|--------|-----|------|
| Index (publish/update) | POST | `https://ai-indexing.yomi-alarape.workers.dev/index` | `X-Webhook-Secret` |
| Extract PDF | POST | `https://ai-indexing.yomi-alarape.workers.dev/extract-pdf` | `X-Webhook-Secret` |
| Deindex (unpublish/delete) | POST | `https://ai-indexing.yomi-alarape.workers.dev/deindex` | `X-Webhook-Secret` |

**Auth header:** Every request must include:
```
X-Webhook-Secret: <shared-secret-agreed-by-both-teams>
```

---

## Scenario 1: Publishing a Video Lesson

**Trigger:** Admin creates a new video lesson and publishes it.

The LMS backend sends this webhook **after the course/lesson is published**:

```
POST https://ai-indexing.yomi-alarape.workers.dev/index
Content-Type: application/json
X-Webhook-Secret: lms-shared-secret-abc123

{
  "event": "publish",
  "org_id": "7591945d-10ba-4a39-adde-a495c2c9449b",
  "entity": {
    "id": "019f5a2c-8d41-7abc-9def-123456789abc",
    "title": "Prompt Engineering for SMEs",
    "contentType": "video",
    "cloudflareVideoId": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "streamStatus": "ready",
    "course_id": "019f0513-90ba-7170-bf05-8011a0e3f028",
    "module_id": "019f0513-9405-73fd-a19b-b011e3a3c11f"
  }
}
```

**What happens:**
1. Worker receives the webhook
2. Checks `streamStatus` — if "ready", fetches captions from Cloudflare Stream
3. If captions exist → downloads VTT file → extracts text
4. If no captions → generates AI captions → polls until ready → downloads
5. Splits transcript into ~2000-character chunks
6. Embeds each chunk using Workers AI (bge-large-en-v1.5)
7. Upserts all chunks to Vectorize with metadata
8. Done in 30-60 seconds

**Result:** Learners can now ask the AI tutor about this lesson and get answers grounded in the actual transcript.

---

## Scenario 2: Uploading a PDF/Presentation

**Trigger:** Admin uploads a PDF or PowerPoint to a lesson.

```
POST https://ai-indexing.yomi-alarape.workers.dev/extract-pdf
Content-Type: application/json
X-Webhook-Secret: lms-shared-secret-abc123

{
  "r2Key": "content/document/2026/07/14/uuid/module-2-lesson-3-core-lecture.pdf",
  "lesson_id": "019f06d2-d178-73fa-a99a-bca5278c89d6",
  "title": "Mapping and Transforming Business Processes with AI",
  "org_id": "7591945d-10ba-4a39-adde-a495c2c9449b",
  "course_id": "019f0513-90ba-7170-bf05-8011a0e3f028",
  "module_id": "019f06d0-c82a-70f8-a176-806c8b27f6a3"
}
```

**What happens:**
1. Worker fetches PDF from R2 bucket
2. Extracts text (supports PDF, PPTX, TXT, MD)
3. Queues the extracted text for indexing
4. Queue consumer chunks → embeds → upserts to Vectorize
5. Usually complete within 1-2 minutes

**Result:** PDF content is searchable by the AI tutor.

---

## Scenario 3: Updating or Republishing Content

**Trigger:** Admin edits a lesson or republishes a course.

Same as Scenario 1 or 2. The worker detects the existing vectors, deletes them, and re-indexes from scratch with the updated content.

```
POST https://ai-indexing.yomi-alarape.workers.dev/index
X-Webhook-Secret: lms-shared-secret-abc123

{
  "event": "publish",
  "org_id": "7591945d-10ba-4a39-adde-a495c2c9449b",
  "entity": {
    "id": "019f5a2c-8d41-7abc-9def-123456789abc",
    "title": "Prompt Engineering for SMEs (Updated)",
    "contentType": "video",
    "cloudflareVideoId": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "streamStatus": "ready",
    "course_id": "019f0513-90ba-7170-bf05-8011a0e3f028",
    "module_id": "019f0513-9405-73fd-a19b-b011e3a3c11f"
  }
}
```

---

## Scenario 4: Unpublishing or Deleting Content

**Trigger:** Admin unpublishes or deletes a course/lesson.

```
POST https://ai-indexing.yomi-alarape.workers.dev/deindex
Content-Type: application/json
X-Webhook-Secret: lms-shared-secret-abc123

{
  "event": "unpublish",
  "org_id": "7591945d-10ba-4a39-adde-a495c2c9449b",
  "entity": {
    "id": "019f5a2c-8d41-7abc-9def-123456789abc"
  }
}
```

**What happens:** All vectors for that lesson are removed from Vectorize. The AI tutor can no longer reference this content.

---

## Entity Field Reference

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `id` | ✅ | LMS lesson UUID | `019f5a2c-8d41-...` |
| `title` | ✅ | Lesson title | `Prompt Engineering for SMEs` |
| `contentType` | ✅ | `"video"`, `"pdf"`, `"ppt"`, `"document"` | `video` |
| `cloudflareVideoId` | For videos | Stream video UID | `a1b2c3d4...` |
| `streamStatus` | For videos | `"ready"` or `"processing"` | `ready` |
| `course_id` | ✅ | Parent course UUID | `019f0513-90ba-...` |
| `module_id` | ✅ | Parent module UUID | `019f0513-9405-...` |
| `org_id` | ✅ | Organization UUID | `7591945d-10ba-...` |
| `durationSeconds` | Optional | Video duration | `300` |

---

## When to Fire Webhooks

| LMS Event | Webhook | When |
|-----------|---------|------|
| Course published | `POST /index` (for each video lesson) | After all lessons are saved |
| Lesson created (video) | `POST /index` | After Stream video is `ready` |
| Lesson created (PDF) | `POST /extract-pdf` | After PDF upload completes |
| Lesson updated | `POST /index` or `/extract-pdf` | After save |
| Lesson deleted | `POST /deindex` | After deletion |
| Course unpublished | `POST /deindex` (for each lesson) | After unpublish |
| Course republished | `POST /index` (for each lesson) | After republish |

---

## Implementation Notes

1. **Fire and forget.** The worker returns `202 Accepted` immediately. Actual indexing happens asynchronously via a queue. You don't need to wait or poll.

2. **Idempotent.** Sending the same webhook twice is safe. The worker cleans up old vectors before re-indexing.

3. **Batch if needed.** You can send webhooks in parallel for multiple lessons in a course.

4. **Video readiness.** Only send the `/index` webhook for videos when `streamStatus` is `"ready"`. If it's still processing, wait for the Cloudflare Stream webhook to notify you, then send ours.

5. **Error handling.** If the webhook fails (non-2xx), retry with exponential backoff. The worker queues jobs, so a failed delivery doesn't lose data — just delays indexing.

6. **Webhook secret.** Both teams agree on a shared value. The LMS sets it as a config/env var. The AI team sets it as `LMS_WEBHOOK_SECRET` in the worker via `wrangler secret put`.

---

## Quick Start — Send a Test Webhook

```bash
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-shared-secret" \
  -d '{
    "event": "publish",
    "org_id": "7591945d-10ba-4a39-adde-a495c2c9449b",
    "entity": {
      "id": "test-lesson-001",
      "title": "Test Lesson",
      "contentType": "video",
      "cloudflareVideoId": "f73fe2ef28ed83162a4bf59b84a93001",
      "streamStatus": "ready",
      "course_id": "019f0513-90ba-7170-bf05-8011a0e3f028",
      "module_id": "019f0513-9405-73fd-a19b-b011e3a3c11f"
    }
  }'
```

Expected response:
```json
{"status": "queued", "message": "Indexing job for test-lesson-001 accepted"}
```

---

## Contact

For questions about the webhook integration, reach out to the AI infrastructure team.
