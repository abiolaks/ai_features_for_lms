# AI Feature Data Requirements

> What the AI layer needs from the LMS, and what it stores itself.  
> LMS owns all course/learner/quiz data via its REST API.  
> AI Workers **read** from LMS, **store** only AI-specific data in Cloudflare infra.

---

## Data Ownership Boundary

```
┌─────────────────────────────────────────────────────────────┐
│  LMS (owns all platform data)                                │
│                                                              │
│  GET /v1/catalog                  → course catalogue         │
│  GET /v1/courses/{id}             → course detail            │
│  GET /v1/modules/{id}/lessons     → module lessons           │
│  GET /v1/lessons/{id}             → lesson content           │
│  GET /v1/learner/profile          → profile + gamification   │
│  GET /v1/learner/preferences      → learner preferences      │
│  GET /v1/progress/user            → progress + enrollments   │
│  GET /v1/learner/assessments/{id} → assessment results       │
│  POST /v1/learner/assessments/{id}/submit → submit quiz     │
│  GET /v1/analytics/dashboard/skill-gaps → skill gaps        │
│  GET /v1/courses/recommendations  → LMS recommendations      │
└──────────────────────┬──────────────────────────────────────┘
                       │  AI Workers READ via HTTPS
                       │  (X-API-Key: LMS_INTERNAL_KEY)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare (AI-owned data only)                             │
│                                                              │
│  Vectorize → embedded lesson chunks (built from LMS content) │
│  D1        → AI budgets, generated assessments, approvals    │
│  KV        → recommendation cache, health status             │
│  DO        → conversation history (tutor, assistant)         │
│  R2        → raw lesson text (for indexing pipeline)         │
│  Queues    → async indexing jobs                             │
└─────────────────────────────────────────────────────────────┘
```

**Rule:** If the LMS has an endpoint for it, the AI Worker calls that endpoint. No duplicating LMS data in D1.

---

## What the LMS Provides — Endpoint Reference

### Course & Content Data

| LMS Endpoint | Returns | Used By |
|-------------|---------|---------|
| `GET /v1/catalog` | `[{ id, title, description, difficulty, category, ... }]` | AI06, AI07 |
| `GET /v1/courses/{id}` | `{ id, title, description, difficulty, modules: [...] }` | AI04a, AI10a, AI11 |
| `GET /v1/courses/recommendations` | `string` (LMS recs) | AI07 (enhances) |
| `GET /v1/modules/{id}/lessons` | `[{ id, title, order, ... }]` | AI01b, AI02 |
| `GET /v1/lessons/{id}` | `{ id, title, content, module_id, course_id, ... }` | AI01a, AI04a, AI08, AI09, AI10a |

### Learner Data

| LMS Endpoint | Returns | Used By |
|-------------|---------|---------|
| `GET /v1/learner/profile` | `{ id, name, email, role, gamification: { points, level, streak, badges }, learning_stats: { completed, in_progress, completion_rate, certificates } }` | AI06, AI07, AI09 |
| `GET /v1/learner/preferences` | `[...]` (preferences, goals, language) | AI06, AI07 |
| `GET /v1/learner/activity-summary` | `{ summary: { days_active, courses_completed, time_spent }, streaks: { login, learning } }` | AI06, AI09 |

### Progress & Enrollment Data

| LMS Endpoint | Returns | Used By |
|-------------|---------|---------|
| `GET /v1/progress/user` | `{ userId, enrollments: [{ courseId, courseTitle, progressPercent, status, timeSpent, completedLessons, totalLessons }] }` | AI06, AI07, AI08, AI09 |
| `GET /v1/enrollments/my-enrollments` | `[{ enrollmentId, courseId, status, ... }]` | AI09 |

### Assessment Data

| LMS Endpoint | Returns | Used By |
|-------------|---------|---------|
| `GET /v1/learner/assessments` | `[{ id, title, courseId, status, score, ... }]` | AI08, AI11 |
| `GET /v1/learner/assessments/{id}` | Assessment with questions + results + per-question timing | AI08 |
| `POST /v1/learner/assessments/{id}/submit` | Request: `{ attemptId, responses: [{ questionId, selectedOption, timeSpentSeconds }] }` | AI08 (reads results) |

### Admin & Analytics

| LMS Endpoint | Returns | Used By |
|-------------|---------|---------|
| `GET /v1/analytics/dashboard/skill-gaps` | `{ skillGapAnalysis: [...], recommendations: [...] }` | AI06 (input to paths) |
| `GET /v1/admin/dashboard` | `{ totalCourses, totalEnrollments, completionRate, ... }` | AI13 (dashboard) |
| `GET /v1/health` | Health status | AI12 |

---

## What AI Workers Store — Cloudflare Infra

### Vectorize — Embedded Lesson Chunks

**Populated by:** AI01b Indexing Worker  
**Queried by:** AI02 RAG, AI04a Tutor, AI10a Question Gen  
**Embedding model:** Workers AI `bge-m3` (1024-dim)

```
Each vector entry:
  id:            uuid
  values:        [1024-dim float32]
  metadata:
    org_id:            "org-1"
    course_id:         "python-intermediate"
    module_id:         "mod-3"
    lesson_id:         "lesson-functions"
    lesson_title:      "Functions and Scope"
    section_heading:   "Defining Functions"
    chunk_index:       2
    text:              "To define a function in Python, use the def keyword..."
```

**How it's populated:**

```
1. AI Worker calls LMS: GET /v1/lessons/{id}
2. Receives lesson.content (full text)
3. AI01a chunks into ~512-token segments
4. Workers AI bge-m3 embeds each chunk
5. Vectorize.upsert(chunks) with full metadata
```

**Org isolation:** Every Vectorize query includes `filter: { org_id }`. LancedB-equivalent pattern in Vectorize.

### D1 — AI-Specific Data Only

The only data stored in D1 is what the LMS doesn't own:

```sql
-- AI budget tracking (not in LMS)
CREATE TABLE org_budgets (
  org_id TEXT PRIMARY KEY,
  monthly_token_cap INTEGER DEFAULT 1000000,
  tokens_used_this_period INTEGER DEFAULT 0,
  billing_period_start INTEGER
);

-- Generated assessments (AI10a creates, LMS doesn't store these)
CREATE TABLE generated_assessments (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,          -- references LMS lesson
  course_id TEXT NOT NULL,          -- references LMS course
  org_id TEXT NOT NULL,
  questions TEXT NOT NULL,          -- JSON array of generated questions
  source_chunk_ids TEXT NOT NULL,   -- JSON array of Vectorize chunk IDs
  status TEXT DEFAULT 'pending',    -- pending | approved | rejected
  approved_by TEXT,
  approved_at INTEGER,
  generated_at INTEGER NOT NULL
);

-- Approval state (AI10b, not needed if LMS admin handles this)
CREATE TABLE approval_log (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  action TEXT NOT NULL,             -- approve | reject
  actor TEXT NOT NULL,
  reason TEXT,
  acted_at INTEGER NOT NULL
);
```

**What we do NOT store in D1:** courses, lessons, learner profiles, enrollments, quiz results, gamification, streaks, skill gaps — the LMS owns all of this.

### KV — Caches & Health

| Key Pattern | Value | TTL | Written By | Read By |
|-------------|-------|-----|------------|---------|
| `recs:{org_id}:{learner_id}` | JSON recommendations | 24h | AI07 | AI07 |
| `health:ai03` | `"ok"` or `"degraded"` | 30s | AI12 | All Workers |
| `health:lms` | `"ok"` or `"degraded"` | 30s | AI12 | All Workers |

### Durable Objects — Conversation History

| DO Class | Stores | TTL | Used By |
|----------|--------|-----|---------|
| `TutorConversation` | `[{ question, answer, citations, timestamp }]` | 30 days | AI04a/b |
| `AssistantConversation` | `[{ question, answer, action_type, timestamp }]` | 30 days | AI09 |

### R2 — Raw Content (Indexing Source)

```
raw/{org_id}/{course_id}/
  └── {lesson_id}.txt     ← Lesson text for chunking
```

**Populated by:** Either LMS content export, or AI01b fetches directly from LMS API.

### Queues — Async Indexing

```
indexing-jobs → AI01b Worker consumes
  Message: { lesson_id, org_id, course_id }
```

---

## Per-Feature Data Flow

### AI01a/b — Indexing Pipeline

```
READ:  GET /v1/lessons/{id}           → lesson.content
WRITE: Vectorize                       → embedded chunks + metadata
       R2 (temp)                       → raw text staging
       Queues                          → indexing jobs
```

### AI02 — RAG Retrieval

```
READ:  Vectorize                       → relevant chunks (filtered by org_id + scope)
WRITE: nothing                         → returns chunks to caller
```

### AI04a — Tutor

```
READ:  GET /v1/lessons/{id}           → lesson structure (title, sections for citations)
       Vectorize                       → relevant chunks (via AI02)
       AI03 Service Binding            → LLM response
WRITE: nothing                         → returns answer + citations to caller
```

### AI06 — Learning Paths

```
READ:  GET /v1/catalog                 → all published courses
       GET /v1/learner/profile         → skills, gamification, stats
       GET /v1/progress/user           → enrollments + progress
       GET /v1/analytics/dashboard/skill-gaps → org skill gaps
       AI03 Service Binding            → LLM path generation
WRITE: nothing                         → returns path to caller
```

### AI07 — Enhanced Recommendations

```
READ:  GET /v1/courses/recommendations → LMS baseline recs
       GET /v1/catalog                 → course details
       GET /v1/learner/profile         → learner context
       GET /v1/progress/user           → enrollment history
       KV (cache)                      → cached recs (24h TTL)
       AI03 Service Binding            → LLM "why this fits" explanations
WRITE: KV                              → cache recommendations (24h TTL)
```

### AI08 — Post-Quiz Insights

```
READ:  GET /v1/learner/assessments/{id} → assessment results + per-question timing
       GET /v1/progress/user           → course progress context
       GET /v1/lessons/{id}            → lesson sections (for review links)
       AI03 Service Binding            → LLM insight generation
WRITE: nothing                         → returns insight to caller
```

### AI09 — Platform Assistant

```
READ:  GET /v1/progress/user           → progress data
       GET /v1/enrollments/my-enrollments → enrollment list
       GET /v1/learner/activity-summary → activity + streaks
       GET /v1/lessons/{id}            → current lesson context
       DO (AssistantConversation)      → conversation history
       AI03 Service Binding            → LLM response
WRITE: DO                              → new messages in conversation
```

### AI10a — Question Generation

```
READ:  GET /v1/lessons/{id}           → lesson content
       GET /v1/courses/{id}            → course difficulty
       Vectorize                       → full course-scope chunks
       AI03 Service Binding            → LLM question generation (quality tier)
WRITE: D1 (generated_assessments)      → store generated questions
```

### AI10b — Approval Workflow

```
READ:  D1 (generated_assessments)      → pending questions
WRITE: D1                              → update status (approved/rejected)
       D1 (approval_log)               → record approval action
```

### AI11 — Quality Checks

```
READ:  GET /v1/courses/{id}           → course difficulty
       D1 (generated_assessments)      → questions to check
       Vectorize                       → duplicate detection (cosine similarity)
       AI03 Service Binding            → reading level check
WRITE: nothing                         → returns check results to caller
```

### AI12 — Fail Gracefully

```
READ:  GET /v1/health                  → LMS health
       AI03 Service Binding            → AI Gateway health
WRITE: KV                              → health status (30s TTL)
```

---

## MVP: Minimum Viable Data

### What we MUST have from LMS (non-negotiable)

| LMS Endpoint | Why |
|-------------|-----|
| `GET /v1/lessons/{id}` | Without lesson content, no chunking, no RAG, no tutor |
| `GET /v1/catalog` | Without catalogue, no paths, no recommendations |
| `GET /v1/learner/profile` | Without profile, no personalization |
| `GET /v1/progress/user` | Without progress, no insights, no "next lesson" |
| `GET /v1/learner/assessments/{id}` | Without results, no post-quiz insights |

### What we MUST set up in Cloudflare

| Infra | Why |
|-------|-----|
| **Vectorize** + bge-m3 index | RAG retrieval needs embedded chunks |
| **D1** (`org_budgets`) | AI03 needs budget tracking |
| **KV** | Recommendation cache, health checks |
| **AI03 Gateway Worker** | Calls Workers AI, enforces budget |

### What we can defer to Post-MVP

| Item | Why defer |
|------|-----------|
| D1 `generated_assessments` | Only needed for AI10a (post-MVP) |
| D1 `approval_log` | Only needed for AI10b (post-MVP) |
| Durable Objects | Only needed for AI04b/09 conversation history (post-MVP) |
| R2 | Index directly from LMS API response, no need to stage in R2 |
| Queues | Indexing can be synchronous for MVP |
| `GET /v1/analytics/dashboard/skill-gaps` | AI06 works without it (weaker paths but functional) |
| `GET /v1/courses/recommendations` | AI07 can generate recs from catalogue alone |

---

## Data Not Needed from LMS

Some LMS endpoints return data the AI layer doesn't use:

| LMS Endpoint | AI Feature | Why Not Needed |
|-------------|------------|----------------|
| `GET /v1/gamification/widgets/data` | — | LMS renders gamification UI, AI doesn't touch it |
| `GET /v1/learner/badges` | — | Badge rendering is UI concern |
| `GET /v1/learner/points-timeline` | — | Point history is UI concern |
| `GET /v1/certificates/*` | — | Certificate generation is LMS concern |
| `GET /v1/departments` | — | Org structure is admin concern |
| `GET /v1/users` | — | User management is LMS concern |
| `GET /v1/login-activity/*` | — | Login tracking is LMS concern |

**Rule of thumb:** If the LMS endpoint is about rendering UI, managing users, or infrastructure — the AI layer doesn't need it. AI Workers only call LMS endpoints that return data needed for prompt construction.

---

## How the LMS Response Format Works

All LMS endpoints return:

```json
{
  "success": true,
  "data": { ... },       // ← AI Workers extract this
  "message": "string",
  "timestamp": "string"
}
```

Every AI Worker uses the same fetch pattern:

```typescript
async function fetchLMS(path: string, env: Env): Promise<unknown> {
  const res = await fetch(`${env.LMS_GATEWAY_URL}/api${path}`, {
    headers: {
      'X-API-Key': env.LMS_INTERNAL_KEY,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`LMS ${res.status}: ${path}`);
  const json = await res.json<{ success: boolean; data: unknown }>();
  return json.data;
}
```
