# AI Services API Contract

> For the LMS Backend Engineer — everything you need to integrate.
> Also see `lms-api-contract-for-backend.md` for the full LMS-side contract.

## Base URLs

| Service | URL |
|---------|-----|
| Content Indexing | `https://ai-indexing.yomi-alarape.workers.dev` |
| AI Tutor | `https://ai-tutor.yomi-alarape.workers.dev` |
| Learning Paths | `https://ai-paths.yomi-alarape.workers.dev` |
| Recommendations | `https://ai-recommendations.yomi-alarape.workers.dev` |
| Post-Quiz Insights | `https://ai-insights.yomi-alarape.workers.dev` |
| LLM Gateway | Internal only — not called directly |
| Demo Dashboard | `https://ai-dashboard.pages.dev` (Pages) |

---

## 1. Index a Lesson

Call this every time a course/lesson is **published** or **updated**.

```
POST {base}/index
Content-Type: application/json
```

### Request

- An example below

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

## 4. Generate Learning Path

Call this when a learner visits their learning path or dashboard. Returns an AI-personalized, ordered list of courses based on their profile, progress, and available catalogue.

```
POST {base}/paths/generate
Content-Type: application/json
```

### Request

```json
{
  "learner_id": "l1",
  "org_id": "org-wragby"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `learner_id` | string | Yes | LMS learner ID |
| `org_id` | string | Yes | Tenant identifier |

**That is the entire payload.** The worker fetches everything else itself from the LMS API (authenticated with the shared internal key):

| Worker fetches | LMS endpoint called | Used for |
|----------------|--------------------|----------|
| Learner profile | `GET /api/v1/learner/profile` | Skills, goals, experience level, streak/points |
| Course catalogue | `GET /api/v1/catalog?organization_id={org_id}` (falls back to `GET /api/v1/public/courses` if empty) | Courses available to sequence |
| Progress | `GET /api/v1/progress/user?userId={learner_id}` | Completed / in-progress courses |

> ℹ️ The request body also accepts optional `profile`, `catalogue`, and `progress` fields. These are **test-mode fallbacks only** — used when the LMS API is unreachable. Do **not** send them from the LMS; the worker's own fetch always takes priority.

### Response (200 — path generated)

```json
{
  "path": [
    {
      "course_title": "Data Science Fundamentals",
      "order": 1,
      "why_this_fits": "Bridges your Python and SQL skills to ML concepts."
    },
    {
      "course_title": "Machine Learning 101",
      "order": 2,
      "why_this_fits": "Directly aligned with your goal of becoming an ML engineer."
    }
  ],
  "ai_status": "generated"
}
```

| Field | Notes |
|-------|-------|
| `path[].course_title` | Course name from the catalogue |
| `path[].order` | Position in path (1-based, prerequisites first) |
| `path[].why_this_fits` | One-sentence AI explanation of why this course fits the learner |
| `ai_status` | `"generated"` — AI-produced path, `"insufficient_data"` — no profile/goals, `"degraded"` — LLM unavailable |

### Response (200 — insufficient data)

```json
{
  "path": [
    {
      "course_title": "Python Basics",
      "order": 1,
      "why_this_fits": "Add skills and goals to get personalized recommendations."
    }
  ],
  "ai_status": "insufficient_data"
}
```

Returned when the learner has no profile, skills, or goals set. Shows the full catalogue as a browse view. Prompt the learner to fill in their profile for better results.

### Response (200 — degraded)

```json
{
  "path": [
    {
      "course_title": "Python Basics",
      "order": 1,
      "why_this_fits": ""
    }
  ],
  "ai_status": "degraded"
}
```

Returned when the LLM is unavailable. Shows catalogue order without AI explanations. `why_this_fits` will be empty.

### Response (400)

```json
{ "error": "missing_field: learner_id" }
{ "error": "missing_field: org_id" }
```

### Learner Profile Lifecycle — how the path stays personalized

The worker is **completely stateless**. It stores no path, no profile snapshot — every call re-fetches the learner profile fresh from the LMS. Call the endpoint **every time the learner opens the learning path page**, regardless of profile state; the `ai_status` in the response tells the UI what to render:

```
Learner opens "My Learning Path"
        │
        ▼
LMS → POST /paths/generate { learner_id, org_id }
        │
        ▼
Worker → GET /v1/learner/profile   (reads whatever exists RIGHT NOW)
        │
        ├── profile has skills/goals ──→ ai_status: "generated"
        │                                → show personalized ordered path
        │
        └── profile empty ─────────────→ ai_status: "insufficient_data"
                                         → show catalogue + "set your goals" CTA
```

**First visit (no goals set):** the response is `insufficient_data` — show the catalogue plus a call-to-action ("Add your skills and goals to get a personalized path"). The goals/skills form is an **LMS UI feature**; the learner fills it, the LMS saves it to the profile, then re-calls `/paths/generate` — now it returns a personalized path.

**Editing goals later:** allowed at any time. Because the worker re-fetches the profile on every call, a changed goal is reflected the very next time the learner opens the page. No cache invalidation or "regenerate" signal is needed on the AI side.

> ⚠️ **LMS dependency — profile fields.** Personalization quality depends on `skills`, `goals`, `experience_level`, and `interests` on the learner profile. These fields are present in the LMS contract but currently return empty for staging users. Until learners populate these fields (onboarding, profile settings), recommendations and paths fall back to catalogue-based scoring (`ai_status: "generated"`) rather than deeply personalized results (`ai_status: "enhanced"`). The AI workers handle this gracefully — no changes needed on the AI side once the fields are populated.

---

## 5. Post-Quiz Insights

Call this **after a quiz attempt is submitted and scored** — on the results screen. Returns a personalized, encouraging coaching insight plus review links for the topics the learner missed.

```
POST {base}/insights/generate
Content-Type: application/json
```

### Request

```json
{
  "attempt_id": "019f7030-af13-7393-991d-b70dbdf9dc47",
  "learner_id": "364772bb-81db-481c-9a20-f0c88f863bce",
  "org_id": "7591945d-10ba-4a39-adde-a495c2c9449b"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `attempt_id` | string | Yes | The **completed** attempt ID from `POST /learner/assessments/{id}/submit` |
| `learner_id` | string | Yes | The attempt owner's user ID (used to fetch course progress) |
| `org_id` | string | Yes | Tenant identifier |

The worker fetches everything else itself from the LMS API: attempt responses (per-question correctness, timing, correct answers), assessment metadata (title, courseId, moduleId), learner progress, and the module's lesson list for review links.

### Response (200 — generated)

```json
{
  "insight_text": "Don't worry, you've got this! You're 65% through the course... Let's focus on reviewing AI roadmaps and organizational resilience.",
  "missed_topics": [
    {
      "topic": "AI roadmap",
      "review_link": "/courses/019f0513-.../lessons/019f121d-8f4b-..."
    },
    {
      "topic": "Organizational resilience",
      "review_link": "/courses/019f0513-.../lessons/019f121d-f762-..."
    }
  ],
  "tone_check": "encouraging",
  "ai_status": "generated"
}
```

| Field | Notes |
|-------|-------|
| `insight_text` | 1 short paragraph. Always references real score + course progress. Never shaming — tone rules are enforced in the prompt. Render as plain text. |
| `missed_topics[].topic` | Topic name derived from actually-missed questions (max ~3) |
| `missed_topics[].review_link` | Relative LMS path `/courses/{courseId}/lessons/{lessonId}`. Lesson IDs are real (sourced from the module listing) — safe to link directly. **May be `""`** if no lesson matched; hide the link in that case. |
| `tone_check` | Always `"encouraging"` |
| `ai_status` | `"generated"` — real AI insight. `"degraded"` — LLM or LMS unavailable, placeholder text returned. |

### Response (200 — degraded)

```json
{
  "insight_text": "Insights unavailable right now — check back shortly.",
  "missed_topics": [],
  "tone_check": "encouraging",
  "ai_status": "degraded"
}
```

Never fails hard — degraded mode always returns 200 with a friendly placeholder. Show it or silently hide the insights panel; do **not** retry in a loop.

### Response (400)

```json
{ "error": "missing_field: attempt_id" }
{ "error": "missing_field: learner_id" }
{ "error": "missing_field: org_id" }
```

### Frontend notes

- **Latency is ~5–8 seconds** (LLM call). Fire the request as soon as the results screen mounts and show a skeleton/loading state — don't block the score display on it.
- Perfect scores still get an insight (congratulatory, empty `missed_topics`).
- The endpoint is stateless — safe to re-call for the same attempt (e.g., learner revisits the results page), but consider caching the response client-side or LMS-side per attempt to avoid duplicate LLM cost.

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

- [ ] Lesson publish → call `POST /index` with `X-Webhook-Secret` header
- [ ] Lesson update → call `POST /index` again (re-indexes)
- [ ] Lesson delete → call `POST /deindex`
- [ ] Learner asks question → call `POST /tutor/ask` with `lesson_id`
- [ ] Learner views dashboard → call `POST /paths/generate` with `learner_id` + `org_id`
- [ ] Quiz submitted → call `POST /insights/generate` with `attempt_id` + `learner_id` + `org_id` (async, with loading state)
- [ ] Hide review links when `review_link` is `""`
- [ ] Handle `scope_expansion_suggested: true` → offer wider search to learner
- [ ] Handle `ai_status: "insufficient_data"` → prompt learner to fill in profile (goals/skills form is LMS-owned)
- [ ] Add `skills`, `goals`, `experience_level`, `interests` to learner profile schema + edit UI (blocks path personalization)
- [ ] Handle `ai_status: "degraded"` → show catalogue without AI explanations
- [ ] Handle errors — 4xx is your fault, 5xx is retryable
