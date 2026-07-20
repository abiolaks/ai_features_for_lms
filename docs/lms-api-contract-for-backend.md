# LMS API Contract — AI Workers

> For the LMS Backend Team. What you need to build, what we expose, and how to connect them.

```
LMS_WEBHOOK_SECRET=**********************
```

## Quick Reference — What You Need to Do

| # | Action |
|---|--------|
| 1 | **Give the AI team:** your `LMS_GATEWAY_URL` + pick an `LMS_INTERNAL_KEY` and share it |
| 2 | **Receive from the AI team:** the `LMS_WEBHOOK_SECRET` — use it when calling the `ai-indexing` Worker | Done
| 3 | **Build 3 P0 endpoints:** `GET /v1/learner/profile`, `GET /v1/catalog`, `GET /v1/progress/user` |
| 4 | **Add auth middleware:** validate `X-API-Key` header against `LMS_INTERNAL_KEY` on these endpoints |
| 5 | **Call the webhook:** `POST /index` on `ai-indexing` Worker when a lesson is published/updated (see below) |

## Quick Test — Verify Everything Works

### Who Calls What — URL Map

```
┌──────────────────────────────────────────────────────────────────┐
│  LMS BACKEND (Python) — your code                                │
│                                                                  │
│  Calls these (with X-Webhook-Secret):                           │
│    POST https://ai-indexing.yomi-alarape.workers.dev/index      │
│    POST https://ai-indexing.yomi-alarape.workers.dev/deindex     │
│    POST https://ai-indexing.yomi-alarape.workers.dev/backfill   │
│                                                                  │
│  Exposes these (validates X-API-Key):                           │
│    GET  /api/v1/learner/profile                                  │
│    GET  /api/v1/catalog                                          │
│    GET  /api/v1/public/courses          (catalog fallback)       │
│    GET  /api/v1/progress/user                                    │
│    GET  /api/v1/lessons/{lesson}                                 │
│    GET  /api/v1/learner/assessments/{id}         (AI08)          │
│    GET  /api/v1/learner/assessments/attempts/{id} (AI08)         │
│    GET  /api/v1/modules/{moduleId}/lessons        (AI08)         │
│    GET  /api/v1/health                                           │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  LMS FRONTEND (browser JavaScript) — your code                  │
│                                                                  │
│  Calls these (no auth — will sit behind LMS Gateway later):     │
│    POST https://ai-tutor.yomi-alarape.workers.dev/tutor/ask     │
│    POST https://ai-tutor.yomi-alarape.workers.dev/tutor/clear   │
│    wss://ai-tutor.yomi-alarape.workers.dev/tutor/ws?learner_id= │
│    POST https://ai-paths.yomi-alarape.workers.dev/paths/generate│
│    POST https://ai-insights.yomi-alarape.workers.dev/insights/generate│
│                                                                  │
│  What you pass from backend → frontend:                         │
│    learner_id  — the LMS user ID (e.g., "user-42")              │
│    lesson_id   — the ID of the current lesson                   │
│    course_id   — the ID of the current course                   │
│    org_id      — the organization ID                            │
│                                                                  │
│  You do NOT open WebSockets from the backend. The browser does. │
│  You just embed learner_id in the page, and the frontend uses it.│
└──────────────────────────────────────────────────────────────────┘
```

### Verify with Curl

```bash
# 1. Publish a video lesson (returns instantly — 202 Accepted)
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $LMS_WEBHOOK_SECRET" \
  -d '{
    "event": "publish",
    "org_id": "org-wragby",
    "entity": {
      "id": "lesson-001",
      "title": "Getting Started",
      "contentType": "video",
      "cloudflareVideoId": "<your-stream-video-id>",
      "streamStatus": "ready",
      "course_id": "course-001"
    }
  }'

# 2. Ask the tutor a question (HTTP)
curl -X POST https://ai-tutor.yomi-alarape.workers.dev/tutor/ask \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is this lesson about?",
    "learner_id": "learner-42",
    "lesson_id": "lesson-001",
    "course_id": "course-001",
    "org_id": "org-wragby"
  }'

# 3. Unpublish a lesson
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/deindex \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $LMS_WEBHOOK_SECRET" \
  -d '{
    "event": "unpublish",
    "org_id": "org-wragby",
    "entity": { "id": "lesson-001" }
  }'

# 4. Backfill — re-index all Stream videos
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/backfill \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $LMS_WEBHOOK_SECRET" \
  -d '{"org_id": "org-wragby"}'
```

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
LMS Frontend ──POST /paths/generate───────▶ ai-paths Worker
              ──POST /tutor/ask───────────▶ ai-tutor Worker
              ──POST /recommendations/────▶ ai-recommendations Worker
              ──POST /insights────────────▶ ai-insights Worker
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
| `ai-tutor` | LMS Frontend | Pull | Per-learner Durable Object (session isolation) | LMS Gateway → internal route |
| `ai-insights` | LMS Frontend | Pull | Open (stub mode) | LMS Gateway → internal route |
| `ai-recommendations` | LMS Frontend | Pull | Open | LMS Gateway → internal route |
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

## Endpoint 6 — Assessment & Attempt Data (AI08 Post-Quiz Insights)

> **Live and verified** against staging (2026-07-17). The `ai-insights` worker calls all three after a quiz is submitted.

### 6a. Attempt Detail

```
GET /api/v1/learner/assessments/attempts/{attemptId}
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

**Response** (AI Workers extract from `.data`):

```json
{
  "success": true,
  "data": {
    "id": "019f7030-...",
    "userId": "364772bb-...",
    "assessmentId": "019f121f-...",
    "courseId": "019f0513-...",
    "scorePercent": 20,
    "totalQuestions": 5,
    "correctAnswers": 1,
    "timeTakenSeconds": 180,
    "responses": [
      {
        "questionId": "019f121f-...",
        "selectedOption": "A",
        "isCorrect": false,
        "timeSpentSeconds": 15,
        "correctAnswer": "B",
        "question": {
          "id": "019f121f-...",
          "questionText": "According to the unit, ...",
          "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
          "correctAnswer": "B",
          "explanation": "..."
        }
      }
    ]
  }
}
```

> **Contract note:** `responses[]` must be an array of **objects** (as above), not JSON-encoded strings. `options` is a **dict keyed `A`–`D`**, not a list. The worker normalizes both shapes defensively, but this is the canonical form.

**Fields AI Workers use:**

| Field | Purpose |
|-------|---------|
| `scorePercent`, `correctAnswers`, `totalQuestions` | Score context in the insight |
| `responses[].isCorrect` | Identify missed questions |
| `responses[].timeSpentSeconds` | Flag questions with unusually long time (>60s) |
| `responses[].question.questionText` | Topic extraction for review links |
| `responses[].correctAnswer` | Shown to the LLM for coaching context |

### 6b. Assessment Metadata

```
GET /api/v1/learner/assessments/{assessmentId}
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

**Fields AI Workers use:** `title` (quiz name in the insight), `courseId` (review link base), `moduleId` (bridge to the module lesson list).

### 6c. Module Lessons

```
GET /api/v1/modules/{moduleId}/lessons
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

**Response** — note: `{ "data": [...] }` with **no `success` flag** on this wrapper:

```json
{
  "data": [
    { "id": "019f121d-...", "title": "Welcome and Objectives", "moduleId": "...", "courseId": "...", "sortOrder": 1 }
  ]
}
```

**Used for:** building validated review links (`/courses/{courseId}/lessons/{lessonId}`) by matching missed-question topics to lesson titles. The quiz's own lesson entry is excluded automatically.

---

## AI Tutor API (for LMS Frontend)

The LMS frontend calls these endpoints directly to power the in-lesson tutor widget.

### Architecture: Per-Learner Durable Objects

Each learner gets their own **Durable Object** — a dedicated, long-lived instance that persists conversation history in SQLite. The worker routes requests deterministically by `learner_id`.

```
LMS Frontend                    ai-tutor Worker
─────────────                   ──────────────
POST /tutor/ask                  ┌──────────────────────┐
  learner_id: "user-42"  ──────▶ │ TutorSession         │
                                 │ "session-user-42"    │
                                 │                      │
                                 │ SQLite:              │
                                 │  messages table      │
                                 │  ← persists across  │
                                 │    requests, crashes │
                                 │    and deployments  │
                                 └──────────────────────┘
```

**Key behaviors:**
- Same `learner_id` always reaches the same DO (deterministic routing)
- Conversation persists across browser tabs, refreshes, and worker redeploys
- Max 20 messages kept in context (older ones auto-pruned)
- Each learner is isolated — learner-42 cannot see learner-99's history

---

### POST /tutor/ask

```
POST https://ai-tutor.yomi-alarape.workers.dev/tutor/ask
Content-Type: application/json
```

**Request:**

```json
{
  "question": "What are list comprehensions?",
  "learner_id": "user-42",
  "lesson_id": "lesson-pdf-123",
  "course_id": "course-py",
  "org_id": "org-wragby",
  "expand_scope": "lesson"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `question` | `string` | ✅ | The learner's question |
| `learner_id` | `string` | ✅ | Routes to the right DO session. Must be stable per learner |
| `lesson_id` | `string` | ✅ | Scopes content search to this lesson |
| `course_id` | `string` | ✅ | Used for scope expansion and filtering |
| `org_id` | `string` | ✅ | Org isolation |
| `expand_scope` | `string` | ❌ | `"lesson"` (default), `"module"`, or `"course"` — broadens content search |
| `module_id` | `string` | ❌ | Required only when `expand_scope: "module"` |

**Response (200):**

```json
{
  "answer": "List comprehensions provide a concise way to create lists using the syntax [expr for item in iterable]. [Python Basics, Page 12]",
  "citations": [
    {
      "lesson_title": "Python Basics",
      "excerpt": "List comprehensions provide a concise way to create lists...",
      "score": 0.91
    }
  ],
  "scope_expansion_suggested": false,
  "history_length": 6
}
```

| Field | Type | Notes |
|-------|------|-------|
| `answer` | `string` | Grounded answer with inline citations |
| `citations` | `array` | Source excerpts from indexed content |
| `citations[].lesson_title` | `string` | Title of the source lesson |
| `citations[].excerpt` | `string` | Relevant content snippet (up to 2000 chars) |
| `citations[].score` | `number` | Semantic similarity score (0–1) |
| `scope_expansion_suggested` | `boolean` | `true` when no matches found in current scope — frontend can prompt user to broaden |
| `history_length` | `number` | Total messages in this session (user + assistant). Starts at 2 for first exchange |

**Response — no matches (200):**

```json
{
  "answer": "I couldn't find that in this lesson.",
  "citations": [],
  "scope_expansion_suggested": true,
  "history_length": 2
}
```

**Response — validation error (400):**

```json
{
  "error": "missing_field: lesson_id"
}
```

**Response — gateway error (502):**

```json
{
  "error": "AI Gateway error: ..."
}
```

---

### POST /tutor/clear

Clears a learner's entire conversation history. Useful for "start fresh" or when a learner switches lessons.

```
POST https://ai-tutor.yomi-alarape.workers.dev/tutor/clear
Content-Type: application/json

{
  "learner_id": "user-42"
}
```

**Response (200):**

```json
{
  "status": "cleared"
}
```

**When to call this:**
- Learner clicks "New conversation" in the tutor widget
- Learner navigates to a completely different course
- Learner's session expires / logout

---

### GET /tutor/ws — WebSocket Streaming (for frontend, not backend)

> **The LMS backend does NOT open WebSockets.** The browser does. You just pass `learner_id`, `lesson_id`, `course_id`, `org_id` to the frontend. The frontend opens the WebSocket using those IDs.

Opens a persistent WebSocket connection for real-time token streaming. Words appear as the LLM generates them — no spinner, no waiting.

```
wss://ai-tutor.yomi-alarape.workers.dev/tutor/ws?learner_id=user-42
```

> **Query param:** `learner_id` — routes to the correct Durable Object session. Same value as HTTP `learner_id`.

#### Protocol

| Direction | Message | When |
|-----------|---------|------|
| Client → Server | `{"type":"ask","question":"...","lesson_id":"...","course_id":"...","org_id":"..."}` | Ask a question |
| Server → Client | `{"type":"citations","citations":[{...}]}` | Sources found (sent before streaming starts — show these in the UI immediately) |
| Server → Client | `{"type":"token","text":"Jira"}` | Each word as the LLM generates it |
| Server → Client | `{"type":"done","answer":"...","history_length":4}` | Stream complete, exchange saved to SQLite |
| Client → Server | `{"type":"cancel"}` | Stop generation (stub — not yet implemented) |
| Server → Client | `{"type":"error","error":"..."}` | Any error |

#### JavaScript Example

```javascript
const ws = new WebSocket(
  `wss://ai-tutor.yomi-alarape.workers.dev/tutor/ws?learner_id=${learnerId}`
);

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "ask",
    question: "What is this lesson about?",
    lesson_id: currentLessonId,
    course_id: currentCourseId,
    org_id: currentOrgId
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.type) {
    case "citations":
      // Show source list immediately
      showCitations(data.citations);
      break;
    case "token":
      // Append each word as it arrives — feels like ChatGPT
      appendToken(data.text);
      break;
    case "done":
      // Answer complete, history_length updated
      console.log("Done. Messages in session:", data.history_length);
      break;
    case "error":
      showError(data.error);
      break;
  }
};
```

#### When to use WebSocket vs HTTP

| Use WebSocket when | Use HTTP when |
|--------------------|--------------|
| Real-time tutor widget in lesson view | Simple integration, testing, or curl debugging |
| User expects streaming responses | You don't want to manage WebSocket connections |
| Production frontend | Backward compatibility |

**HTTP and WebSocket share the same Durable Object** — conversation history persists across both. A question sent via HTTP will be remembered when the user reconnects via WebSocket.

---

## AI Recommendations API (for LMS Frontend)

The LMS frontend calls these endpoints to render "Recommended for you" and "What's next?" widgets on the dashboard and course pages.

### Architecture: Enhance + Fallback Engine

```
LMS Frontend                    ai-recommendations Worker
─────────────                   ──────────────────────────
POST /recommendations/dashboard  ┌────────────────────────┐
  learner_id, org_id       ────▶ │ 1. KV cache check      │
                                 │ 2. Fetch LMS recs      │
                                 │ 3a. LMS recs present?  │
                                 │    → enhance with AI   │
                                 │ 3b. LMS recs empty?    │
                                 │    → engine: catalog   │
                                 │      + AI scoring      │
                                 │ 4. Cache (24h TTL)    │
                                 └────────────────────────┘
```

**Key behaviors:**
- Two endpoints: `/recommendations/dashboard` and `/recommendations/next`
- LMS returns recommendations → worker enhances with AI-generated "why this fits"
- LMS returns empty (cold start) → worker generates from catalogue + AI scoring
- KV cache with 24h TTL, scoped per `{org, learner}`. Bypass with `?refresh=true`
- Both GET (query params) and POST (JSON body) supported
- POST body supports stub data (`profile`, `catalogue`, `progress`, `lms_recommendations`) for demo/testing

---

### POST /recommendations/dashboard

```
POST https://ai-recommendations.yomi-alarape.workers.dev/recommendations/dashboard
Content-Type: application/json
```

**Request:**

```json
{
  "learner_id": "user-42",
  "org_id": "org-wragby",
  "refresh": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `learner_id` | `string` | ✅ | Used for KV cache key and progress lookup |
| `org_id` | `string` | ✅ | Org isolation, catalogue scoping |
| `refresh` | `boolean` | ❌ | Bypass KV cache. Default `false` |
| `profile` | `object` | ❌ | Stub mode: learner profile (skills, goals, experience_level) |
| `catalogue` | `array` | ❌ | Stub mode: course list with title, difficulty, category, prerequisites |
| `progress` | `array` | ❌ | Stub mode: enrollment list with title, status (completed/in_progress), progress_pct |
| `lms_recommendations` | `array` | ❌ | Stub mode: LMS baseline recs to enhance |

**GET alternative (query params):**

```
GET /recommendations/dashboard?learner_id=user-42&org_id=org-wragby&refresh=false
```

**Response — enhanced (200, LMS recs present with AI explanations):**

```json
{
  "recommendations": [
    {
      "course_title": "Python Basics",
      "lms_reason": "Popular in your org",
      "ai_why_this_fits": "Matches your Python skill and ML engineering goal.",
      "score": 94,
      "fit_level": "strong",
      "signals": {
        "content_similarity": 0.9,
        "ai_score": 92
      }
    }
  ],
  "ai_status": "enhanced",
  "generated_at": "2026-07-18T00:00:00Z",
  "source": "fresh"
}
```

**Response — generated (200, LMS recs empty, engine generated from catalogue):**

```json
{
  "recommendations": [
    {
      "course_title": "Data Science Fundamentals",
      "lms_reason": "",
      "ai_why_this_fits": "Bridges your Python skills into data science — natural next step.",
      "score": 85,
      "fit_level": "strong",
      "signals": {
        "content_similarity": 0.72,
        "ai_score": 85
      }
    }
  ],
  "ai_status": "generated",
  "generated_at": "2026-07-18T00:00:00Z",
  "source": "fresh"
}
```

**Response — cache hit (200):**

```json
{
  "recommendations": [...],
  "ai_status": "generated",
  "generated_at": "2026-07-18T00:00:00Z",
  "source": "cache"
}
```

**Response — degraded (200, AI03 Gateway down):**

```json
{
  "recommendations": [
    {
      "course_title": "Python Basics",
      "lms_reason": "Popular in your org",
      "ai_why_this_fits": "",
      "score": 0,
      "fit_level": "weak",
      "signals": { "content_similarity": 0, "ai_score": 0 }
    }
  ],
  "ai_status": "degraded",
  "generated_at": "2026-07-18T00:00:00Z",
  "source": "fresh"
}
```

**Response — unavailable (200, no catalogue data):**

```json
{
  "recommendations": [],
  "ai_status": "unavailable",
  "generated_at": "2026-07-18T00:00:00Z"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `recommendations` | `array` | Up to 5 ranked recommendations |
| `recommendations[].course_title` | `string` | LMS course title |
| `recommendations[].lms_reason` | `string` | Baseline reason from LMS (empty if engine-generated) |
| `recommendations[].ai_why_this_fits` | `string` | AI-generated one-sentence explanation (empty if degraded) |
| `recommendations[].score` | `number` | 0-100 blended score |
| `recommendations[].fit_level` | `string` | `"strong"` (>80), `"moderate"` (50-80), `"weak"` (<50) |
| `recommendations[].signals` | `object` | Signal breakdown: `content_similarity` (0-1), `ai_score` (0-100) |
| `ai_status` | `string` | `"enhanced"`, `"generated"`, `"degraded"`, or `"unavailable"` |
| `source` | `string` | `"fresh"` or `"cache"` — indicates KV cache hit |

---

### POST /recommendations/next

Returns recommended next courses after the learner completes a specific course. Biased toward progression — prerequisite chains, difficulty+1, collaborative patterns.

```
POST https://ai-recommendations.yomi-alarape.workers.dev/recommendations/next
Content-Type: application/json
```

**Request:**

```json
{
  "learner_id": "user-42",
  "org_id": "org-wragby",
  "course_id": "course-python-basics"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `learner_id` | `string` | ✅ | KV cache key, progress lookup |
| `org_id` | `string` | ✅ | Org isolation |
| `course_id` | `string` | ✅ | The completed course — used for prereq boost and context |

**GET alternative:**

```
GET /recommendations/next?learner_id=user-42&org_id=org-wragby&course_id=course-python-basics
```

**Response (200):**

```json
{
  "next_courses": [
    {
      "course_title": "Advanced Python",
      "why_this_fits": "Builds directly on Python Basics — natural next step for your skill level.",
      "score": 85,
      "fit_level": "strong"
    }
  ],
  "ai_status": "generated",
  "generated_at": "2026-07-18T00:00:00Z"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `next_courses` | `array` | Up to 3 ranked next courses |
| `next_courses[].course_title` | `string` | LMS course title |
| `next_courses[].why_this_fits` | `string` | AI-generated reason (progression-context) |
| `next_courses[].score` | `number` | 0-100 blended score (includes +15 prereq boost) |
| `next_courses[].fit_level` | `string` | `"strong"`, `"moderate"`, or `"weak"` |

**Prerequisite boost:** Courses that list the completed `course_id` as a prerequisite receive +15 points. This ensures progression chains are respected.

**Response — validation error (400):**

```json
{ "error": "missing_field: course_id" }
```

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

### Architecture: Async Queue (indexing is not instant)

`POST /index` pushes work to a Cloudflare Queue. The LMS gets a **202 Accepted** response immediately (sub-100ms). The Worker's queue consumer picks up the job, fetches VTT, generates embeddings, and upserts to Vectorize in the background.

```
LMS:   POST /index ──▶ 202 Accepted (instant!)
                        │
                        ▼
                 ┌─────────────────┐
                 │  indexing-jobs  │
                 │  Queue          │
                 │  ┌───────────┐  │
                 │  │ job-1     │──┼──▶ Worker picks up
                 │  │ job-2     │  │    → Fetch VTT
                 │  │ job-3     │  │    → Chunk + Embed
                 │  └───────────┘  │    → Upsert Vectorize
                 │  batch_size=3   │    → Retry 3x on failure
                 └─────────────────┘
```

**Implication for the LMS:** The 202 response means the job was accepted, NOT that it finished processing. There is no callback. If a video fails to index (bad captions, Vectorize error), it will be retried automatically up to 3 times. Check the `ai-indexing` Worker logs via Cloudflare Dashboard if you need to verify indexing status.

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
| Job accepted (queued) | `202` | `{ "status": "queued", "message": "Indexing job for lesson-abc123 accepted" }` |
| Video not ready yet (pushed to queue anyway, returns instantly) | `202` | `{ "status": "queued" }` |
| Missing field | `400` | `{ "error": "Missing org_id" }` |
| Invalid webhook secret | `401` | `{ "error": "Unauthorized — invalid or missing X-Webhook-Secret" }` |
| Successfully deindexed | `200` | `{ "status": "deindexed", "vectors_removed": 3 }` |
| Backfill accepted | `200` | `{ "status": "queued", "queued": 7, "skipped": 2 }` |

**Retry logic for the LMS:**
- All `/index` calls return `202` instantly — the queue handles retries internally (3 attempts)
- Any `4xx` (400, 401) → do not retry, fix the request
- Any `5xx` (rare) → retry with exponential backoff (1s, 2s, 4s, max 3 attempts)
- **Do not re-send `/index` for the same lesson** thinking it failed — the queue may still be processing it

### POST /backfill — Re-index all Stream videos

Bulk re-indexes every ready video in Cloudflare Stream. Pushes one queue job per video.

```bash
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/backfill \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <shared-secret>" \
  -d '{"org_id": "org-wragby"}'
```

**Response (200):**
```json
{ "status": "queued", "queued": 7, "skipped": 2 }
```

- `queued`: number of videos pushed to the indexing queue
- `skipped`: videos with `status !== "ready"` (pending upload, processing)

---

## PDF & PPT Content Indexing

> **Status:** Built. ai-indexing Worker extracts PDF/PPTX from R2 using `unpdf`.

### How It Works — Two Paths

#### Path A: R2 Upload (recommended — zero LMS code)

The LMS uploads PDF/PPTX files to the `lms-content-staging` R2 bucket. The ai-indexing Worker fetches and extracts text automatically.

```
┌────────────────────────────────────────────────────────────┐
│  LMS Backend                                               │
│                                                            │
│  1. Upload file to R2 (lms-content-staging bucket)         │
│  2. Send webhook with r2Key pointing to the file:          │
│                                                            │
│  POST /index                                                │
│  {                                                          │
│    "event": "publish",                                      │
│    "org_id": "org-wragby",                                   │
│    "entity": {                                              │
│      "id": "lesson-pdf-123",                                │
│      "title": "Introduction to Python",                     │
│      "contentType": "pdf",                                  │
│      "r2Key": "uploads/lesson-pdf-123.pdf"                  │
│    }                                                        │
│  }                                                          │
└──────────────────────┬─────────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────────┐
│  ai-indexing Worker                                        │
│                                                            │
│  1. Fetches file from R2 (lms-content-staging)             │
│  2. Extracts text:                                         │
│     PDF → unpdf (JS, Workers-compatible)                   │
│     PPTX → custom parser (shapes → text)                   │
│  3. Chunks text into ~2000-char pieces                     │
│  4. Embeds each chunk → bge-large-en-v1.5 (1024-dim)       │
│  5. Stores in Vectorize with metadata (content_type,        │
│     page/slide number, lesson_id, course_id, org_id)       │
│  6. Queued: 202 Accepted, processed async                  │
└────────────────────────────────────────────────────────────┘
```

#### Path B: LMS Pre-Extraction (optimized — faster indexing)

The LMS extracts text upfront and sends it in `entity.content`. The Worker skips R2 fetch + extraction, going straight to chunking.

```json
{
  "event": "publish",
  "org_id": "org-wragby",
  "entity": {
    "id": "lesson-pdf-123",
    "title": "Introduction to Python",
    "contentType": "pdf",
    "content": "Chapter 1: Getting Started\nPython is a..."
  }
}
```

If `entity.content` is present, the Worker uses it directly. If absent but `r2Key` is present, it fetches from R2. If neither is present, it falls back to metadata-only indexing (title + description).

### Extraction Libraries

| Format | Library | Where It Runs |
|--------|---------|--------------|
| PDF | `unpdf` (JS) | ai-indexing Worker |
| PPTX | Custom parser (shapes → text) | ai-indexing Worker |
| Video (VTT) | WebVTT parser | ai-indexing Worker |

**The LMS does NOT need Python PDF libraries.** The Worker handles extraction natively in JavaScript. If the LMS wants to pre-extract for speed, any text extraction tool works — just send the text in `entity.content`.

### Chunking Strategy

| Content Type | How It's Chunked | Citation Format |
|-------------|-----------------|----------------|
| **Video** | Transcript split at ~2000 chars, sentence boundaries | `[Title]` |
| **PDF** | Text split at ~2000 chars, sentence boundaries | `[Title, Page X]` |
| **PPT** | Each slide typically 1 chunk | `[Title, Slide X]` |

### LMS Responsibilities vs Worker Responsibilities

| Task | Who | Why |
|------|-----|-----|
| Upload PDF/PPTX to R2 | **LMS Backend** | Simple file upload to R2 bucket using S3 API |
| Extract text from PDF/PPTX | **Worker** (unpdf) | No Python dependency needed. unpdf runs natively in Workers. |
| Optionally pre-extract text | **LMS Backend** (optional) | Faster indexing — skip the R2 fetch + extraction step |
| Chunk text for embedding | **Worker** | Splits at sentence boundaries, handles Vectorize metadata limits |
| Embed & store vectors | **Worker** | Uses Workers AI (bge-large-en-v1.5) |
| Query & cite | **Worker (tutor)** | Searches Vectorize, builds grounded prompts, returns citations |

### Citation Format by Content Type

```json
{
  "answer": "List comprehensions... [Introduction to Python, Page 12]",
  "citations": [
    {
      "source_title": "Introduction to Python",
      "source_type": "pdf",
      "location": "Page 12",
      "excerpt": "List comprehensions provide a concise way...",
      "score": 0.91
    }
  ]
}
```

| Content Type | `source_type` | `location` |
|-------------|--------------|------------|
| Video | `"video"` | `null` (continuous media) |
| PDF | `"pdf"` | `"Page X"` |
| PPT | `"ppt"` | `"Slide X"` |
| Text lesson | `"text"` | `null` |

### Implementation Checklist

- [x] **ai-indexing Worker:** Fetch PDF/PPTX from R2 (lms-content-staging)
- [x] **ai-indexing Worker:** Extract text via unpdf (PDF) + custom parser (PPTX)
- [x] **ai-indexing Worker:** Read `entity.content` if present (pre-extracted path)
- [x] **ai-indexing Worker:** Fall back to metadata-only if no content available
- [x] **ai-indexing Worker:** Store `content_type`, `page_number`, `slide_number` in Vectorize metadata
- [x] **ai-tutor Worker:** Include `source_type` and `location` in citation response
- [x] **ai-tutor Worker:** Format page/slide numbers in LLM prompt context
- [ ] **LMS Backend (optional):** Upload PDF/PPTX files to R2 bucket if using Path A
- [ ] **LMS Backend (optional):** Pre-extract and send `entity.content` if using Path B

---

## What If These Endpoints Don't Exist Yet?

> ⚠️ **Historical section — the endpoints below now exist and are live.** The AI Workers fetch from them directly. Inline request-body data (`profile`, `catalogue`, `progress`) is retained only as a fallback when the LMS is unreachable; do not send it in production.

### Build Priority (what to implement first)

| Status | Endpoint | Unblocks |
|--------|----------|----------|
| ✅ Live | `GET /v1/learner/profile` | AI06, AI07, AI09 |
| ✅ Live | `GET /v1/catalog` (+ `/v1/public/courses` fallback) | AI06, AI07 |
| ✅ Live | `GET /v1/progress/user` | AI06, AI07, AI08, AI09 |
| ✅ Live | `GET /v1/lessons/{lesson}` | AI01, AI04, AI10 |
| ✅ Live | `GET /v1/health` | AI12 |
| ✅ Live | `GET /v1/learner/assessments/{id}` + `/attempts/{id}` + `/v1/modules/{id}/lessons` | AI08 (see Endpoint 6) |
| 🟢 P2 | `GET /v1/learner/activity-summary` | AI06, AI09 |
| 🔴 **P0 gap** | `skills`, `goals`, `experience_level`, `interests` on learner profile + edit UI | AI06 personalization — without these every learner gets `insufficient_data` |



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
