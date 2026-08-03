# AI Workers — LMS Integration Guide

> For the LMS Team. All 7 deployed workers, their endpoints, and how to integrate.

---

## Deployed Workers (all live)

| Worker | URL | Called by | Purpose |
|--------|-----|-----------|---------|
| **ai-indexing** | `ai-indexing.yomi-alarape.workers.dev` | LMS backend | Webhook: content publishing → chunks → Vectorize |
| **ai-tutor** | `ai-tutor.yomi-alarape.workers.dev` | LMS frontend (browser) | Grounded Q&A with citations, WebSocket streaming |
| **ai-paths** | `ai-paths.yomi-alarape.workers.dev` | LMS frontend (browser) | Personalized learning paths |
| **ai-recommendations** | `ai-recommendations.yomi-alarape.workers.dev` | LMS frontend (browser) | "Recommended for you" + "What's next?" |
| **ai-insights** | `ai-insights.yomi-alarape.workers.dev` | LMS frontend (browser) | Post-quiz coaching + mentor session prep |
| **ai-assistant** | `ai-assistant.yomi-alarape.workers.dev` | LMS frontend (browser) | Platform-wide chat assistant — course discovery, topic Q&A, multi-turn conversation |
| **mentor** | `mentor.yomi-alarape.workers.dev` | LMS frontend (browser) | Skill-gap analysis — compare learner skills vs catalogue |
| **ai-gateway** | Internal only (service binding) | Other AI workers | LLM routing, token budgeting (never called by LMS) |

---

## Integration Patterns

```
┌─────────────────────────────────────────────────────────────────┐
│ PATTERN A: LMS Backend → AI Workers (webhooks)                  │
│                                                                 │
│  LMS fires webhooks when content is published/updated/deleted   │
│                                                                 │
│  POST /index    ← new/updated lesson                            │
│  POST /deindex  ← deleted/unpublished lesson                    │
│  POST /backfill ← re-index all videos                           │
│                                                                 │
│  Auth: X-Webhook-Secret header                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PATTERN B: AI Workers → LMS Backend (REST)                      │
│                                                                 │
│  LMS exposes these endpoints for AI Workers to pull data:       │
│                                                                 │
│  GET /api/v1/learner/profile                                    │
│  GET /api/v1/catalog                                            │
│  GET /api/v1/progress/user?userId=<id>                          │
│  GET /api/v1/lessons/{id}                                       │
│  GET /api/v1/health                                             │
│  GET /api/v1/learner/assessments/{id}                           │
│  GET /api/v1/learner/assessments/attempts/{id}                  │
│  GET /api/v1/modules/{moduleId}/lessons                         │
│  GET /api/v1/learner/assessments/summary?userId=&org_id=       │
│                                                                 │
│  Auth: X-API-Key header (LMS_INTERNAL_KEY)                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PATTERN C: LMS Frontend → AI Workers (browser → Workers)        │
│                                                                 │
│  The LMS browser frontend calls these directly:                 │
│                                                                 │
│  POST /tutor/ask              ← ask a question                  │
│  POST /tutor/clear            ← reset conversation              │
│  WS  /tutor/ws?learner_id=    ← streaming Q&A                  │
│  POST /paths/generate         ← generate learning path          │
│  POST /recommendations/dashboard  ← "For You" widget            │
│  POST /recommendations/next   ← "What's next?" after course     │
│  POST /insights/generate      ← quiz coaching                   │
│  POST /mentor/session-prep   ← mentor session agenda           │
│  POST /assistant/ask          ← platform-wide Q&A               │
│  POST /assistant/clear        ← reset assistant conversation     │
│  GET  /mentor/skill-gap       ← skill-gap analysis              │
│                                                                 │
│  Auth: None currently (open). Will be behind LMS Gateway later. │
│  No secrets needed in frontend code.                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Secrets Exchange

| Secret | Who picks it | Who uses it | Purpose |
|--------|-------------|-------------|---------|
| `LMS_INTERNAL_KEY` | **LMS team** → share with AI team | AI Workers → LMS | Auth for Pattern B calls |
| `LMS_WEBHOOK_SECRET` | **AI team** → share with LMS team | LMS → ai-indexing | Auth for Pattern A webhooks |
| `LMS_GATEWAY_URL` | LMS team (your base URL) | AI Workers | Where AI Workers call the LMS |

---

## Pattern A: Content Indexing Webhooks

### POST /index — Publish or update a lesson

```
POST https://ai-indexing.yomi-alarape.workers.dev/index
X-Webhook-Secret: <shared-secret>
Content-Type: application/json

{
  "event": "publish",
  "org_id": "<org-uuid>",
  "entity": {
    "id": "<lesson-uuid>",
    "title": "Introduction to Python",
    "contentType": "video",
    "cloudflareVideoId": "<stream-video-uid>",
    "streamStatus": "ready",
    "course_id": "<course-uuid>",
    "module_id": "<module-uuid>"
  }
}
```

**Response:** `202 { "status": "queued" }` — indexing happens async. No need to poll.

**When to call:**
- New lesson published
- Lesson content updated
- Stream video status changes to `"ready"`

### POST /deindex — Remove a lesson

```
POST https://ai-indexing.yomi-alarape.workers.dev/deindex
X-Webhook-Secret: <shared-secret>

{
  "event": "unpublish",
  "org_id": "<org-uuid>",
  "entity": { "id": "<lesson-uuid>" }
}
```

**Response:** `200 { "status": "deindexed", "vectors_removed": 3 }`

### POST /backfill — Re-index all videos

```
POST https://ai-indexing.yomi-alarape.workers.dev/backfill
X-Webhook-Secret: <shared-secret>

{ "org_id": "<org-uuid>" }
```

**Response:** `200 { "status": "queued", "queued": 7, "skipped": 2 }`

### PDF/PPTX support — add `contentType` and `r2Key` or `content`

```json
{
  "entity": {
    "id": "<lesson-uuid>",
    "title": "Lecture Slides",
    "contentType": "pdf",
    "r2Key": "uploads/slides.pdf",
    "course_id": "<course-uuid>",
    "module_id": "<module-uuid>"
  }
}
```

If `content` is present (pre-extracted text), worker uses it directly. If absent but `r2Key` is present, worker fetches from R2. Video uses `cloudflareVideoId` instead.

---

## Pattern B: LMS REST API (what LMS must expose)

All endpoints return `{ "success": true, "data": ... }`. Auth via `X-API-Key: <LMS_INTERNAL_KEY>`.

### GET /api/v1/learner/profile

```json
{
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

> ✅ **Resolved:** `GET /api/v1/learner/preferences` exists with `knownSkills`, `interests`, `learningGoal`, `skillLevel`, `preferredCategory`.

### GET /api/v1/catalog

Scoped to authenticated org. Support `?per_page=100` for full catalogue.

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

> ✅ **Resolved:** `CourseResource` includes `prerequisites` field — learning paths can order courses correctly.

### GET /api/v1/progress/user?userId=<id>

```json
{
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

### GET /api/v1/lessons/{id}

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

### GET /api/v1/health

```json
{ "status": "ok" }
```

Called by workers to check LMS reachability before making data calls.

### GET /api/v1/learner/assessments/{id}

```json
{
  "data": {
    "id": "019f121f-...",
    "title": "Unit 2 Quiz",
    "courseId": "019f0513-...",
    "moduleId": "019f06d0-..."
  }
}
```

### GET /api/v1/learner/assessments/attempts/{id}

```json
{
  "data": {
    "id": "019f7030-...",
    "userId": "364772bb-...",
    "assessmentId": "019f121f-...",
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
          "questionText": "According to the unit...",
          "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
          "correctAnswer": "B",
          "explanation": "..."
        }
      }
    ]
  }
}
```

### GET /api/v1/modules/{moduleId}/lessons

```json
{
  "data": [
    { "id": "019f121d-...", "title": "Welcome and Objectives", "moduleId": "...", "courseId": "...", "sortOrder": 1 }
  ]
}
```

Note: wrapper uses `{ "data": [...] }` without a `success` flag.

### GET /api/v1/learner/assessments/summary?userId=<uuid>&organization_id=<uuid>

```json
{
  "success": true,
  "data": {
    "total_attempts": 7,
    "avg_score_percent": 72,
    "lowest_topic": "recursion",
    "lowest_topic_score": 45,
    "recent_attempts": [{"id":"a1","score":68},{"id":"a2","score":82}]
  }
}
```

Used by: `POST /mentor/session-prep` for quiz-based urgency in mentor agendas.

---

## Pattern C: Frontend-Facing APIs

### POST /tutor/ask — Ask the AI tutor a question

```
POST https://ai-tutor.yomi-alarape.workers.dev/tutor/ask
Content-Type: application/json

{
  "question": "What are list comprehensions?",
  "learner_id": "user-42",
  "lesson_id": "lesson-abc",
  "course_id": "course-xyz",
  "org_id": "org-wragby",
  "expand_scope": "lesson"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `question` | ✅ | Learner's question |
| `learner_id` | ✅ | Stable per-learner ID (routes to their Durable Object session) |
| `lesson_id` | ✅ | Scopes search to this lesson |
| `course_id` | ✅ | Context + filtering |
| `org_id` | ✅ | Org isolation |
| `expand_scope` | ❌ | `"lesson"` (default), `"module"`, `"course"` |

**Response (200):**

```json
{
  "answer": "List comprehensions provide a concise way... [Python Basics]",
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

- `scope_expansion_suggested: true` → no matches found in scope. Prompt user to broaden.
- Conversation history persists per learner across tabs/refreshes/redeploys (Durable Object + SQLite).
- Max 20 messages kept in context.

### POST /tutor/clear — Reset conversation

```
POST https://ai-tutor.yomi-alarape.workers.dev/tutor/clear
Content-Type: application/json

{ "learner_id": "user-42" }
```

**Response:** `{ "status": "cleared" }`

Call when: learner clicks "New conversation", navigates to different course, or logs out.

### WebSocket /tutor/ws — Streaming tutor (real-time)

```
wss://ai-tutor.yomi-alarape.workers.dev/tutor/ws?learner_id=user-42
```

> **LMS backend does NOT open WebSockets.** The browser does. Pass `learner_id` to the frontend.

**Protocol:**

| Direction | Message | When |
|-----------|---------|------|
| Browser → Worker | `{"type":"ask","question":"...","lesson_id":"...","course_id":"...","org_id":"..."}` | Ask a question |
| Worker → Browser | `{"type":"citations","citations":[...]}` | Sources found (show immediately) |
| Worker → Browser | `{"type":"token","text":"Jira"}` | Each word as LLM generates |
| Worker → Browser | `{"type":"done","answer":"...","history_length":4}` | Stream complete |
| Worker → Browser | `{"type":"error","error":"..."}` | Error |

**JS example:**
```javascript
const ws = new WebSocket(`wss://ai-tutor.yomi-alarape.workers.dev/tutor/ws?learner_id=${learnerId}`);
ws.onopen = () => ws.send(JSON.stringify({ type: "ask", question, lesson_id, course_id, org_id }));
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.type === "citations") showCitations(d.citations);
  if (d.type === "token") appendText(d.text);
  if (d.type === "done") console.log("Complete:", d.history_length);
};
```

### POST /paths/generate — Generate learning path

```
POST https://ai-paths.yomi-alarape.workers.dev/paths/generate
Content-Type: application/json

{
  "learner_id": "user-42",
  "org_id": "org-wragby"
}
```

Worker fetches profile + catalogue + progress from LMS, generates personalized path via LLM.

**Response (200):**

```json
{
  "path": [
    { "course_title": "Python Basics", "order": 1, "why_this_fits": "Matches your Python skill and ML goal." },
    { "course_title": "Data Science 101", "order": 2, "why_this_fits": "Natural progression from Python." }
  ],
  "ai_status": "generated"
}
```

`ai_status`: `"generated"` (success), `"insufficient_data"` (no profile goals/skills set), `"degraded"` (LLM down — generic path returned).

### POST /recommendations/dashboard — "Recommended for you"

```
POST https://ai-recommendations.yomi-alarape.workers.dev/recommendations/dashboard
Content-Type: application/json

{
  "learner_id": "user-42",
  "org_id": "org-wragby",
  "refresh": false
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `refresh` | ❌ | `true` to bypass 24h KV cache |

**Response (200):**

```json
{
  "recommendations": [
    {
      "course_title": "Python Basics",
      "lms_reason": "Popular in your org",
      "ai_why_this_fits": "Matches your Python skill and ML engineering goal.",
      "score": 94,
      "fit_level": "strong"
    }
  ],
  "ai_status": "enhanced",
  "generated_at": "2026-07-18T00:00:00Z",
  "source": "fresh"
}
```

`ai_status`: `"enhanced"` (LMS recs + AI explanations), `"generated"` (cold start, engine-built), `"degraded"` (LLM down), `"unavailable"` (no data).  
`source`: `"fresh"` or `"cache"` (24h KV cache hit).

### POST /recommendations/next — "What's next?" after completing a course

```
POST https://ai-recommendations.yomi-alarape.workers.dev/recommendations/next
Content-Type: application/json

{
  "learner_id": "user-42",
  "org_id": "org-wragby",
  "course_id": "course-python-basics"
}
```

**Response (200):**

```json
{
  "next_courses": [
    {
      "course_title": "Advanced Python",
      "why_this_fits": "Builds directly on Python Basics — natural next step.",
      "score": 85,
      "fit_level": "strong"
    }
  ],
  "ai_status": "generated",
  "generated_at": "2026-07-18T00:00:00Z"
}
```

Prerequisite boost: +15 points if a candidate lists the completed `course_id` as a prerequisite.

### POST /assistant/ask — Platform-wide chat assistant

```
POST https://ai-assistant.yomi-alarape.workers.dev/assistant/ask
Content-Type: application/json

{
  "question": "What courses cover Python?",
  "learner_id": "user-42",
  "org_id": "org-wragby"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `question` | ✅ | Free-text question (max 2000 chars) |
| `learner_id` | ✅ | Stable per-learner ID (routes to their Durable Object session) |
| `org_id` | ✅ | Org isolation — answers scoped to this org's indexed content |

**Response (200):**

```json
{
  "answer": "The platform covers AI topics including machine learning, deep learning, and generative AI.\n\n### Suggested Courses\n- AI-Driven Business Innovation — covers fundamentals of ML and its business applications",
  "citations": [
    {
      "lesson_title": "How AI Actually Works",
      "course_id": "019f0513-90ba-7170-bf05-8011a0e3f028",
      "excerpt": "Machine learning is a central approach within AI because instead of hard coding...",
      "score": 0.79,
      "source_type": "video"
    }
  ],
  "suggested_courses": [
    {
      "title": "AI-Driven Business Innovation A Practical Guide for SMEs",
      "course_id": "019f0513-90ba-7170-bf05-8011a0e3f028",
      "reason": "Covers the core types of machine learning including supervised and unsupervised learning"
    }
  ],
  "history_length": 4
}
```

**Key differences from the Tutor:**

| | Tutor (POST /tutor/ask) | Assistant (POST /assistant/ask) |
|---|---|---|
| Scope | One lesson | **All courses** |
| Requires | `lesson_id`, `course_id` | Only `learner_id`, `org_id` |
| Returns | `citations` | `citations` + `suggested_courses` |
| Use case | "Explain this concept from the video" | "What should I learn?" / "Which course covers X?" |
| Session | Per learner + course | **Per learner** (one conversation across all courses) |

**Degraded behavior:**
- No matching content → `"I couldn't find that in the platform content."` (citations empty)
- AI Gateway down → returns citations only with `"AI service temporarily unavailable"`
- LMS unreachable → answers with citations + course suggestions from indexed metadata only

**Conversation state:** Persists per learner via Durable Object + SQLite. Max 20 messages in context. Follow-ups like "which one for a beginner?" work because the DO remembers the previous topic.

### POST /assistant/clear — Reset assistant conversation

```
POST https://ai-assistant.yomi-alarape.workers.dev/assistant/clear
Content-Type: application/json

{ "learner_id": "user-42" }
```

**Response:** `{ "status": "cleared" }`

Call when: learner clicks "New conversation" or logs out.

### GET /mentor/skill-gap — Skill-gap analysis

```
GET https://mentor.yomi-alarape.workers.dev/mentor/skill-gap?learner_id=user-42&org_id=org-wragby
```

Compares the learner's current skills against the course catalogue. Identifies gaps and recommends courses with estimated effort.

| Param | Required | Notes |
|-------|----------|-------|
| `learner_id` | ✅ | Stable per-learner ID |
| `org_id` | ✅ | Org isolation, scopes catalogue |

Worker fetches profile + catalogue + progress from LMS, maps skills against course requirements via LLM, returns structured gap analysis.

**Response (200):**

```json
{
  "learner_skills": ["python", "sql"],
  "gaps": [
    {
      "skill": "spark",
      "current_level": "none",
      "required_level": "intermediate",
      "courses_available": 2,
      "estimated_hours": 40
    },
    {
      "skill": "machine learning",
      "current_level": "beginner",
      "required_level": "intermediate",
      "courses_available": 3,
      "estimated_hours": 60
    }
  ],
  "summary": "Strong in Python and SQL. Biggest gap is distributed computing. 3 courses available."
}
```

| Field | Type | Notes |
|-------|------|-------|
| `learner_skills` | `string[]` | Skills extracted from learner profile |
| `gaps` | `GapEntry[]` | Skills the learner is missing |
| `gaps[].skill` | `string` | Name of the missing skill |
| `gaps[].current_level` | `string` | Learner's current proficiency (`none`, `beginner`, `intermediate`, `advanced`) |
| `gaps[].required_level` | `string` | Level needed for catalogue courses |
| `gaps[].courses_available` | `number` | How many courses in catalogue teach this skill |
| `gaps[].estimated_hours` | `number` | Estimated effort to close the gap |
| `summary` | `string` | AI-generated human-readable analysis (2-3 sentences) |

**Empty states:**

| Condition | Response |
|-----------|----------|
| No skills on profile | `learner_skills: []`, `gaps: []`, summary suggesting to add skills |
| No catalogue courses | `learner_skills: [...]`, `gaps: []`, summary noting no courses available |
| LLM unavailable | Gaps computed from course categories/keywords, summary notes degraded status |

**Frontend integration example:**

```javascript
async function getSkillGaps(learnerId, orgId) {
  const url = `https://mentor.yomi-alarape.workers.dev/mentor/skill-gap?learner_id=${learnerId}&org_id=${orgId}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.learner_skills.length === 0) {
    // Prompt learner to add skills to profile
    showAddSkillsPrompt();
    return;
  }

  renderGapAnalysis(data.gaps, data.summary);
}
```

### POST /insights/generate — Post-quiz coaching

```
POST https://ai-insights.yomi-alarape.workers.dev/insights/generate
Content-Type: application/json

{
  "learner_id": "user-42",
  "org_id": "org-wragby",
  "attempt_id": "019f7030-...",
  "assessment_id": "019f121f-..."
}
```

Worker fetches attempt details + assessment metadata + module lessons from LMS, then generates coaching insight via LLM.

**Response (200):**

```json
{
  "insight": {
    "summary": "You scored 20% (1/5). Here's what to focus on...",
    "strengths": ["..."]
  },
  "review_links": [
    { "lesson_title": "Welcome and Objectives", "url": "/courses/019f0513.../lessons/019f121d..." }
  ],
  "ai_status": "generated"
}
```

---

### POST /mentor/session-prep — Mentor session agenda

```
POST https://ai-insights.yomi-alarape.workers.dev/mentor/session-prep
Content-Type: application/json

{
  "learner_id": "<learner-uuid>",
  "mentor_id": "<mentor-uuid>",
  "org_id": "<org-uuid>"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `learner_id` | ✅ | Must be a valid UUID (not plain string like `user-42`) |
| `mentor_id` | ✅ | Stable mentor identifier |
| `org_id` | ✅ | Org isolation |

Worker fetches learner profile, progress, and assessment summary from LMS, identifies stalled modules (<30% progress) and lowest quiz topics, then generates a 3-topic session agenda via LLM prioritized by urgency.

**Response (200):**

```json
{
  "recent_activity": {
    "completed_lessons": 1,
    "quiz_scores": { "avg": 72, "lowest_topic": "recursion" },
    "stalled_modules": ["Advanced Algorithms"]
  },
  "suggested_agenda": [
    {
      "topic": "Recursion review",
      "reason": "Lowest quiz score (45%) — must address foundational gaps",
      "duration_min": 15
    },
    {
      "topic": "Algorithm complexity",
      "reason": "Blocks progress in Advanced Algorithms (12% complete)",
      "duration_min": 20
    },
    {
      "topic": "Next steps toward Data Engineering",
      "reason": "Align with learner goal to become data engineer",
      "duration_min": 10
    }
  ],
  "prep_materials": [
    { "lesson_title": "Python Basics", "link": "/courses/course-101" }
  ],
  "ai_status": "generated"
}
```

`ai_status`: `"generated"` (LLM agenda), `"degraded"` (LLM/gateway down — returns skeleton agenda with generic topics like "Review learner profile", "Assess current progress", "Set session goals").

**Skeleton agenda (no-activity or degraded):**

```json
{
  "suggested_agenda": [
    { "topic": "Review learner profile", "reason": "Understand background, skills, and goals", "duration_min": 10 },
    { "topic": "Assess current progress", "reason": "Review completed courses and identify gaps", "duration_min": 15 },
    { "topic": "Set session goals", "reason": "Align on priorities for today and next steps", "duration_min": 10 }
  ]
}
```

When stalled modules exist, the skeleton injects an "Unblock: <module>" item. `prep_materials` link to courses from the learner's enrollment data.

**LMS endpoints consumed:**
- `GET /api/v1/learner/profile?user_id=<uuid>` — name, skills, goals
- `GET /api/v1/progress/user?userId=<uuid>` — enrollments, stalled modules
- `GET /api/v1/learner/assessments/summary?userId=<uuid>&organization_id=<uuid>` — avg score, lowest topic

> ⚠️ **Note:** `user_id`/`userId` params must be valid UUIDs. Plain strings like `user-42` return 422 validation errors. The progress endpoint returns 500 for users with no enrollments (LMS bug) — worker degrades gracefully.

---

## Quick Curl Tests

```bash
# Index a video lesson
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $LMS_WEBHOOK_SECRET" \
  -d '{"event":"publish","org_id":"org-wragby","entity":{"id":"lesson-001","title":"Getting Started","contentType":"video","cloudflareVideoId":"<video-uid>","streamStatus":"ready","course_id":"course-001","module_id":"module-001"}}'

# Ask the tutor
curl -X POST https://ai-tutor.yomi-alarape.workers.dev/tutor/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What is this lesson about?","learner_id":"learner-42","lesson_id":"lesson-001","course_id":"course-001","org_id":"org-wragby"}'

# Generate a learning path
curl -X POST https://ai-paths.yomi-alarape.workers.dev/paths/generate \
  -H "Content-Type: application/json" \
  -d '{"learner_id":"learner-42","org_id":"org-wragby"}'

# Get recommendations
curl -X POST https://ai-recommendations.yomi-alarape.workers.dev/recommendations/dashboard \
  -H "Content-Type: application/json" \
  -d '{"learner_id":"learner-42","org_id":"org-wragby"}'

# Ask the platform assistant
curl -X POST https://ai-assistant.yomi-alarape.workers.dev/assistant/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What courses cover Python?","learner_id":"learner-42","org_id":"org-wragby"}'

# Clear assistant conversation
curl -X POST https://ai-assistant.yomi-alarape.workers.dev/assistant/clear \
  -H "Content-Type: application/json" \
  -d '{"learner_id":"learner-42"}'

# Skill-gap analysis
curl "https://mentor.yomi-alarape.workers.dev/mentor/skill-gap?learner_id=learner-42&org_id=org-wragby"

# Get post-quiz insights
curl -X POST https://ai-insights.yomi-alarape.workers.dev/insights/generate \
  -H "Content-Type: application/json" \
  -d '{"learner_id":"learner-42","org_id":"org-wragby","attempt_id":"<attempt-uuid>","assessment_id":"<assessment-uuid>"}'

# Get mentor session prep agenda
curl -X POST https://ai-insights.yomi-alarape.workers.dev/mentor/session-prep \
  -H "Content-Type: application/json" \
  -d '{"learner_id":"<learner-uuid>","mentor_id":"<mentor-uuid>","org_id":"<org-uuid>"}'
```

---

## Error Handling

All workers return descriptive errors. Never throw 5xx to clients — errors return 200/400 with status fields.

| Code | Meaning | Action |
|------|---------|--------|
| 200 + `ai_status: "degraded"` | AI unavailable, stub returned | Show stub UI, no retry needed |
| 200 + `ai_status: "unavailable"` | No data at all | Show empty state |
| 400 | Missing/bad field | Fix request |
| 401 | Bad `X-Webhook-Secret` | Check secret value |
| 502 | Gateway error | Retry with backoff |

---

## LMS Checklist

- [ ] Share `LMS_GATEWAY_URL` with AI team
- [ ] Pick `LMS_INTERNAL_KEY` and share with AI team
- [ ] Receive `LMS_WEBHOOK_SECRET` from AI team
- [ ] Build `GET /api/v1/learner/profile` (validate `X-API-Key`)
- [ ] Build `GET /api/v1/catalog` (support `?per_page=100`)
- [ ] Build `GET /api/v1/progress/user?userId=<id>`
- [ ] Build `GET /api/v1/lessons/{id}`
- [ ] Build `GET /api/v1/health`
- [ ] Build `GET /api/v1/learner/assessments/{id}`
- [ ] Build `GET /api/v1/learner/assessments/attempts/{id}`
- [ ] Build `GET /api/v1/modules/{moduleId}/lessons`
- [ ] Build `GET /api/v1/learner/assessments/summary?userId=<uuid>&organization_id=<uuid>` (session prep)
- [ ] Fire `POST /index` webhook when lessons are published/updated
- [ ] Fire `POST /deindex` webhook when lessons are deleted/unpublished
- [ ] (Frontend) Call `POST /tutor/ask` from browser when learner opens tutor widget
- [ ] (Frontend) Call `POST /tutor/clear` on logout/course change
- [ ] (Frontend) Call `POST /paths/generate` for "My Learning Path" page
- [ ] (Frontend) Call `POST /recommendations/dashboard` for "For You" widget
- [ ] (Frontend) Call `POST /recommendations/next` after course completion
- [ ] (Frontend) Call `POST /assistant/ask` from browser when learner opens platform assistant
- [ ] (Frontend) Call `POST /assistant/clear` on logout / "New conversation" click
- [ ] (Frontend) Call `POST /insights/generate` after quiz submission
- [ ] (Frontend) Call `POST /mentor/session-prep` before mentor 1-on-1 sessions
- [ ] (Frontend) Call `GET /mentor/skill-gap` for learner dashboard skill-gap widget
