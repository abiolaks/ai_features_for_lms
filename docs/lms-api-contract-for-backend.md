# LMS API Contract — AI Workers

> For the LMS Backend Team. What the AI Workers need from the LMS REST API.
> 

```
LMS_WEBHOOK_SECRET=**********************
```

## Quick Reference — What You Need to Do

| # | Action |
|---|--------|
| 1 | **Give the AI team:** your `LMS_GATEWAY_URL` + pick an `LMS_INTERNAL_KEY` and share it |
| 2 | **Receive from the AI team:** the `LMS_WEBHOOK_SECRET` — use it when calling AI Worker(ai-index worker) |
| 3 | **Build 3 P0 endpoints:** `GET /v1/learner/profile`, `GET /v1/catalog`, `GET /v1/progress/user` |
| 4 | **Add auth middleware:** validate `X-API-Key` header against `LMS_INTERNAL_KEY` on these endpoints |
| 5 | **Call the webhook:** `POST /index` on `ai-indexing` Worker when a lesson is published/updated (see below) |

---

## Auth: Internal Service Key

Every AI Worker calls the LMS with a shared internal API key:

```
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

The key is an opaque string you pick (e.g., `lms-internal-7a3f1b9c` or a UUID). The Gateway validates it and treats the call as fully trusted. The AI Workers pass `learner_id` / `org_id` / `userId` as query params themselves — no user impersonation needed.

### Secrets to exchange between teams

| Secret | Who Picks | Who Uses It | Who Validates It |
|--------|-----------|-------------|-----------------|
| `LMS_INTERNAL_KEY` | LMS team → shares with AI team | AI Workers → LMS | LMS Gateway |
| `LMS_WEBHOOK_SECRET` | **AI team** → shares with LMS team | LMS → AI Workers | AI Workers |
| `LMS_GATEWAY_URL` | LMS team (the URL they give you) | AI Workers | N/A |

---

## Who Uses Which Secret — and Why Only One Worker Needs the Webhook Secret

There are **two distinct calling patterns** between the LMS and the AI Workers. Only one of them uses `LMS_WEBHOOK_SECRET`.

### Pattern A: Webhook (LMS pushes events to AI Workers)

```
LMS Backend ──POST /index──▶ ai-indexing Worker
             Header: X-Webhook-Secret: <LMS_WEBHOOK_SECRET>
```

- **Who calls:** The LMS backend, in response to internal events (lesson published, updated, unpublished)
- **Who receives:** Only `ai-indexing`
- **Secret used:** `LMS_WEBHOOK_SECRET` (header `X-Webhook-Secret`)
- **Why:** The LMS is making a direct HTTP call to a Cloudflare Worker. No user session is involved. A shared secret is the simplest, most reliable auth for server-to-server webhooks.

### Pattern B: API (LMS or frontend pulls data from AI Workers)

```
LMS Frontend ──POST /paths/generate──▶ ai-paths Worker
              ──POST /tutor/chat─────▶ ai-tutor Worker
              ──POST /insights───────▶ ai-insights Worker
```

- **Who calls:** The LMS frontend (browser) or demo dashboard
- **Who receives:** `ai-paths`, `ai-tutor`, `ai-insights`, `ai-recommendations`, `ai-dashboard`
- **Secret used:** **None yet** — these workers are currently open
- **Why:** These are user-facing APIs. In the final architecture, they sit **behind the LMS Platform Gateway (P10)** which authenticates every request at the edge. The Gateway checks the user's session / `X-API-Key`, then routes internally to the right AI Worker. The Workers themselves don't need to re-check auth — they trust the Gateway.

### Summary Table

| Worker | Called by | Pattern | Auth today | Auth in final architecture |
|--------|-----------|---------|-----------|---------------------------|
| `ai-indexing` | LMS Backend (webhook) | Push | `X-Webhook-Secret` ← `LMS_WEBHOOK_SECRET` | Same |
| `ai-paths` | LMS Frontend | Pull | Open (stub mode) | LMS Gateway → internal route |
| `ai-tutor` | LMS Frontend | Pull | Open (stub mode) | LMS Gateway → internal route |
| `ai-insights` | LMS Frontend | Pull | Open (stub mode) | LMS Gateway → internal route |
| `ai-recommendations` | LMS Frontend | Pull | Open (stub mode) | LMS Gateway → internal route |
| `ai-dashboard` | LMS Frontend | Pull | Open (stub mode) | LMS Gateway → internal route |
| `ai-gateway` | Other AI Workers (internal) | Service binding | Not exposed publicly | Cloudflare Workers service bindings (private network) |

### So: do NOT send X-Webhook-Secret to ai-paths or ai-tutor

Only `ai-indexing` validates it. If your LMS frontend calls `ai-paths` or `ai-tutor`, **do not include the `X-Webhook-Secret` header** — it will be ignored. These workers are designed to be called from the browser or demo dashboard directly.

### What the LMS_WEBHOOK_SECRET value is

The secret is already set on the AI team side as a Cloudflare Worker secret and with the lms backend team:

```
LMS_WEBHOOK_SECRET=**********************
```

It was created with `wrangler secret put LMS_WEBHOOK_SECRET`. The LMS backend must include this exact value in the `X-Webhook-Secret` header when calling `ai-indexing`.

---

## Endpoint 1 — Learner Profile

```
GET /api/v1/learner/profile
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

**No query params needed** — the LMS identifies the learner from the authenticated context.

**Response** (AI Workers extract from `.data`):

```json
{
  "success": true,
  "data": {
    "id": "l1",
    "learning_stats": {
      "completed_courses": 3,
      "in_progress_courses": 1,
      "total_enrollments": 5,
      "average_completion_rate": 0.75,
      "certificates_earned": 1
    },
    "gamification": {
      "total_points": 450,
      "current_level": 3,
      "level_progress": 60,
      "login_streak": 12,
      "badges_earned": 4
    }
  }
}
```

**Fields AI Workers use:**

| Field | Used by | Purpose |
|-------|---------|---------|
| `learning_stats.completed_courses` | AI06, AI07 | Exclude from recommendations |
| `learning_stats.in_progress_courses` | AI06, AI07, AI09 | Show current context |
| `gamification.current_level` | AI06, AI07 | Difficulty calibration |
| `gamification.login_streak` | AI06 | Motivation-aware suggestions |
| `gamification.total_points` | AI06, AI07 | Engagement context |

**Also needed - not be in current schema:** - very important
Consider adding to to make it more personalized

| Field | Type | Purpose |
|-------|------|---------|
| `goals` | `string?` | Learner's stated goal (e.g., "become an ML engineer") |
| `experience_level` | `string?` | `"beginner"`, `"intermediate"`, `"advanced"` |
| `skills` | `string[]` | Known skills (e.g., `["python", "sql"]`) |
| `interests` | `string[]` | Topics they care about |

>  **Gap:** These four fields are not in the current `api.json` spec. If they don't exist yet in the LMS, the AI Workers will still work — paths will just be less personalized. Consider adding them to `/v1/learner/preferences` or as an extension to the profile response.

---

## Endpoint 2 — Course Catalogue

```
GET /api/v1/catalog
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

The LMS scopes to the authenticated context's org. AI Workers don't pass `org_id` as a query param.

**Query params needed (may need to be added):**

| Param | Type | Purpose |
|-------|------|---------|
| `?per_page=100` | `int` | Return more than default 12 (AI06 needs full catalogue) |

**Response** (AI Workers extract from `.data`):

```json
{
  "data": [
    {
      "id": "course-xyz",
      "title": "Python Basics",
      "category": "programming",
      "difficultyLevel": "Beginner",
      "skillsCovered": ["python", "variables", "loops"],
      "status": "published"
    }
  ]
}
```

**Fields AI Workers use:**

| Field | Used by | Purpose |
|-------|---------|---------|
| `title` | AI06, AI07, AI11 | Display and prompt context |
| `category` | AI06, AI07 | Group similar courses |
| `difficultyLevel` | AI06, AI07 | Order from easy to hard |
| `skillsCovered` | AI06, AI07 | Match to learner skills |
| `status` | AI06, AI07 | Filter to `"published"` only |

> **Gap: No `prerequisites` field in `CourseResource`.** AI06 needs to know "Python Basics must be taken before Data Science Fundamentals" to order the path correctly. Without this, the LLM may suggest courses in the wrong order. Options:
> 1. Add a `prerequisites` field (array of course titles or IDs) to `CourseResource`
> 2. Add a separate endpoint: `GET /api/v1/courses/{id}/prerequisites`
> 3. Skip it and rely on the LLM to infer ordering from difficulty + category (less reliable)

---

## Endpoint 3 — Learner Progress

```
GET /api/v1/progress/user?userId=<learner_id>
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

> **The param is `userId`, not `learner_id`.** AI Workers will pass the learner's ID as `userId`.

**Minimal query needed:** just `?userId=<id>` — no other filters.

**Response** (AI Workers extract from `.data`):

```json
{
  "success": true,
  "data": {
    "totalEnrollments": 5,
    "completedEnrollments": 3,
    "enrollments": [
      {
        "courseTitle": "Python Basics",
        "status": "completed",
        "progressPercent": "100"
      },
      {
        "courseTitle": "SQL for Data",
        "status": "enrolled",
        "progressPercent": "60"
      }
    ]
  }
}
```

**Fields AI Workers use:**

| Field | Used by | Purpose |
|-------|---------|---------|
| `enrollments[].courseTitle` | AI06, AI07, AI08 | Match to catalogue |
| `enrollments[].status` | AI06, AI07 | `"completed"` → exclude, `"enrolled"` / `"inProgress"` → show as in-progress |
| `enrollments[].progressPercent` | AI06, AI08 | Context for path and quiz insights |

---

## Endpoint 4 — Lesson Detail (AI01, AI04, AI10)

```
GET /api/v1/lessons/{lesson}
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

**Response** (AI Workers extract from `.data`):

```json
{
  "data": {
    "id": "lesson-abc",
    "title": "Introduction to Variables",
    "content": "<full lesson content>",
    "courseId": "course-xyz",
    "moduleId": "module-001"
  }
}
```

**Used by:**
- **AI01 (Indexing):** Extracts content → chunks → embeds → stores in Vectorize for search
- **AI04 (Tutor):** Fetches lesson metadata for citation titles
- **AI10 (Question Gen):** Reads lesson content to generate assessments

---

## Endpoint 5 — Health (AI12)

```
GET /api/v1/health
```

**Response:**

```json
{
  "status": "ok"
}
```

AI Workers call this to check if the LMS is reachable before making data calls. Used by the graceful degradation system.

---

## LMS → AI Worker Webhook

The LMS calls the AI Indexing Worker whenever a lesson is published or unpublished.

### Endpoint (dev)

```
POST https://ai-indexing.yomi-alarape.workers.dev/index
POST https://ai-indexing.yomi-alarape.workers.dev/deindex
```

### Auth

Include the shared secret as a header on every call:

```
X-Webhook-Secret: <value you received from the AI team>
```

### When to call /index

Call `POST /index` when:
- A new lesson is published
- An existing lesson's content is updated (title, video, description)
- A lesson's `streamStatus` changes from `"pending"` to `"ready"`

### Publish a lesson

```bash
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <shared-secret>" \
  -d '{
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
  }'
```

### Unpublish a lesson

```bash
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/deindex \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <shared-secret>" \
  -d '{
    "event": "unpublish",
    "org_id": "org-wragby",
    "entity": {
      "id": "lesson-abc123"
    }
  }'
```

### Responses

| Scenario | Status | Body |
|----------|--------|------|
| Successfully indexed | `200` | `{ "status": "indexed", "transcript_source": "existing", "content_length": 815 }` |
| Video not ready yet | `202` | `{ "status": "queued", "reason": "video_not_ready" }` |
| Missing field | `400` | `{ "error": "Missing org_id" }` |
| Video processed but no captions | `200` | `{ "status": "indexed", "transcript_source": "none", "content_length": 0 }` |

**Retry logic for the LMS:**
- `202 video_not_ready` → call `/index` again when `streamStatus` becomes `"ready"`
- Any `5xx` → retry with exponential backoff (1s, 2s, 4s, max 3 attempts)
- `4xx` → do not retry, fix the request

---

## What If These Endpoints Don't Exist Yet?

The AI Workers are currently in **stub mode** — they accept data inline in the request body instead of fetching from the LMS. Production-ready code is commented out with `LMS_INTEGRATION` markers.

### Build Priority (what to implement first)

| Priority | Endpoint | Unblocks |
|----------|----------|----------|
| 🔴 P0 | `GET /v1/learner/profile` | AI06, AI07, AI09 |
| 🔴 P0 | `GET /v1/catalog` | AI06, AI07 |
| 🔴 P0 | `GET /v1/progress/user` | AI06, AI07, AI08, AI09 |
| 🟡 P1 | `GET /v1/lessons/{lesson}` | AI01, AI04, AI10 |
| 🟡 P1 | `GET /v1/health` | AI12 |
| 🟢 P2 | `GET /v1/learner/assessments` | AI08, AI11 |
| 🟢 P2 | `GET /v1/learner/activity-summary` | AI06, AI09 |



**Key implementation notes:**
1. All responses wrap data in `{ success: bool, data: ..., message: string? }`
2. Auth is `X-API-Key` header — middleware validates, then the endpoint trusts fully
3. `/v1/catalog` scopes to the authenticated org automatically
4. `/v1/progress/user` takes `userId` as query param (not `learner_id`)
5. Add `prerequisites` to `CourseResource` if possible — or we can add a separate endpoint

### Gaps to fill

| What's Missing | Why It Matters | Workaround |
|----------------|---------------|------------|
| `prerequisites` on courses | AI06 needs prerequisite ordering | AI06 LLM can infer from difficulty/category (less reliable) |
| `goals`, `experience_level`, `skills` on profile | AI06/07 personalization quality | Degraded mode — paths become generic catalogue browse |
| `org_id` filter on catalog | Multi-org isolation | LMS scopes by auth context (already handles this) |
