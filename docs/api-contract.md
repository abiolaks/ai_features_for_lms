# AI Services API Contract

> For the LMS Backend Engineer — everything you need to integrate.

## Base URLs

| Service | Development | Production |
|---------|------------|------------|
| Content Indexing | `https://ai-indexing.yomi-alarape.workers.dev` | `https://ai-indexing.lms.example.com` |
| AI Tutor | `https://ai-tutor.yomi-alarape.workers.dev` | `https://ai-tutor.lms.example.com` |
| LLM Gateway | Internal only — not called directly | Internal only |

---

## 1. Index a Lesson

Call this every time a course/lesson is **published** or **updated**.

```
POST {base}/index
Content-Type: application/json
```

### Request

```json
{
  "event": "publish",
  "org_id": "org-wragby",
  "entity": {
    "id": "lesson-abc123",
    "title": "Introduction to Python",
    "contentType": "video",
    "cloudflareVideoId": "69a5808380ae7cc1536b367b5f45a4aa",
    "streamStatus": "ready",
    "course_id": "course-xyz",
    "module_id": "module-001",
    "durationSeconds": 57
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `event` | string | Yes | Always `"publish"` |
| `org_id` | string | Yes | Tenant identifier |
| `entity.id` | string | Yes | LMS lesson primary key |
| `entity.title` | string | Yes | Display title for citations |
| `entity.contentType` | string | Yes | `"video"` or `"text"` |
| `entity.cloudflareVideoId` | string | For video | Cloudflare Stream video UID |
| `entity.streamStatus` | string | For video | `"pending"` \| `"processing"` \| `"ready"` \| `"error"` |
| `entity.course_id` | string | No | Links lesson to course |
| `entity.module_id` | string | No | Links lesson to module |
| `entity.durationSeconds` | number | No | Video length in seconds |

### Response (200)

```json
{
  "status": "indexed",
  "transcript_source": "existing",
  "content_length": 815
}
```

| Field | Notes |
|-------|-------|
| `transcript_source` | `"existing"` — reused captions, `"ai_generated"` — new captions created, `"none"` — metadata only |
| `content_length` | Characters of transcript indexed |

### Response (202 — video not ready)

```json
{
  "status": "queued",
  "reason": "video_not_ready"
}
```

Video will be indexed when `streamStatus` becomes `"ready"` and a re-publish event is sent.

### Response (400)

```json
{ "error": "Missing event" }
{ "error": "Missing org_id" }
{ "error": "Missing entity" }
```

---

## 2. Remove a Lesson

Call this when a lesson is **unpublished** or **deleted**.

```
POST {base}/deindex
Content-Type: application/json
```

### Request

```json
{
  "event": "unpublish",
  "org_id": "org-wragby",
  "entity": {
    "id": "lesson-abc123"
  }
}
```

### Response (200)

```json
{
  "status": "deindexed"
}
```

### Response (500)

```json
{
  "error": "Deindex failed: item_not_found"
}
```

---

## 3. Ask the AI Tutor

Call this when a learner types a question while watching a lesson.

```
POST {base}/tutor/ask
Content-Type: application/json
```

### Request

```json
{
  "question": "What is a variable in Python?",
  "lesson_id": "lesson-abc123",
  "course_id": "course-xyz",
  "org_id": "org-wragby",
  "expand_scope": "lesson"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `question` | string | Yes | Learner's exact words |
| `lesson_id` | string | Yes | The lesson being watched |
| `course_id` | string | No | Parent course |
| `org_id` | string | Yes | Tenant |
| `expand_scope` | string | No | `"lesson"` (default), `"module"`, or `"course"` |

### Response (200 — answer found)

```json
{
  "answer": "A variable is a named storage location that holds a value.",
  "citations": [
    {
      "lesson_title": "Introduction to Python",
      "excerpt": "Variables store data that can change during program execution...",
      "score": 0.65
    }
  ],
  "scope_expansion_suggested": false
}
```

| Field | Notes |
|-------|-------|
| `answer` | AI-generated answer grounded in the lesson transcript |
| `citations[].lesson_title` | Source lesson name |
| `citations[].excerpt` | Up to 300 chars of relevant transcript |
| `citations[].score` | Relevance 0–1 (higher = better match) |
| `scope_expansion_suggested` | `true` = try wider scope |

### Response (200 — not found)

```json
{
  "answer": "I couldn't find that in this lesson.",
  "citations": [],
  "scope_expansion_suggested": true
}
```

When `scope_expansion_suggested` is `true`, offer the learner a button to "Search entire module" or "Search entire course". Re-call with:

```json
{ "expand_scope": "module" }   // or "course"
```

### Response (400)

```json
{ "error": "missing_field: question" }
{ "error": "missing_field: lesson_id" }
{ "error": "missing_field: org_id" }
```

### Response (502)

```json
{ "error": "AI Gateway error: ..." }
```

Retry after a few seconds. This means the LLM service had a transient failure.

---

## Scope Expansion Flow

The recommended frontend behavior:

```
1. Learner asks question → expand_scope: "lesson"
   ├── Answer found → show it
   └── scope_expansion_suggested: true → show "Search module?" button

2. Learner clicks "Search module" → expand_scope: "module", module_id: "..."
   ├── Answer found → show it
   └── scope_expansion_suggested: true → show "Search course?" button

3. Learner clicks "Search course" → expand_scope: "course"
   ├── Answer found → show it
   └── Show "No results found in this course"
```

---

## Error Codes

| Status | Meaning | Action |
|--------|---------|--------|
| 200 | Success | Use the response |
| 202 | Video queued | Re-send publish event when `streamStatus` is `"ready"` |
| 400 | Bad request | Fix the request body |
| 404 | Wrong endpoint | Check the URL path |
| 405 | Wrong method | Use POST |
| 500 | Server error | Retry with backoff |
| 502 | LLM error | Retry after 3–5 seconds |

---

## Integration Checklist

- [ ] Lesson publish → call `POST /index`
- [ ] Lesson update → call `POST /index` again (re-indexes)
- [ ] Lesson delete → call `POST /deindex`
- [ ] Learner asks question → call `POST /tutor/ask` with `lesson_id`
- [ ] Handle `scope_expansion_suggested: true` → offer wider search to learner
- [ ] Handle errors — 4xx is your fault, 5xx is retryable
