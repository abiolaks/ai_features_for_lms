# AI Workers ↔ LMS API Contract Mapping

> How each AI Worker uses the real LMS API endpoints (from `api.json`).
> Base URL: `http://localhost:8000/api/v1`

---

## LMS Already Has More Than We Planned

The LMS is production-grade — it already has things we planned to build separately:

| What LMS already has | Originally planned as | Action |
|---------------------|----------------------|--------|
| Learner profile (points, streaks, badges, learning stats) | AI05 Learner Profile Service | **Skip AI05** — enrich LMS profile instead |
| Course recommendations | AI07 (partial) | **Enhance** with AI, don't replace |
| Skill gap analysis | AI06 context | **Use** as input to learning paths |
| Assessment submission + results | AI08 needs quiz data | **Use directly** — no need to pass quiz data in request body |
| Gamification (points, levels, streaks) | AI06 context | **Use** for motivation-aware recommendations |

---

## Endpoint-by-Endpoint Mapping

### Lesson Content — Used by: AI01 Chunking, AI02 RAG, AI04a Tutor, AI10a Question Gen

```
GET /api/v1/lessons/{lessonId}
→ { id, title, content, module_id, course_id, ... }
```

```typescript
// AI Worker pattern: fetch lesson for chunking
const lesson = await fetchFromLMS(`/v1/lessons/${lessonId}`, env);
// lesson.content → feed to chunking → embed → index in Vectorize
```

### Module Lessons — Used by: AI01b Indexing (batch), AI02 RAG (scope expansion)

```
GET /api/v1/modules/{moduleId}/lessons
→ [{ id, title, course_id, module_id, ... }]
```

### Course Detail — Used by: AI04a Tutor, AI06 Paths, AI10a Question Gen

```
GET /api/v1/courses/{courseId}
→ { id, title, description, difficulty, modules: [...], ... }
```

### Course Catalogue — Used by: AI06 Paths, AI07 Recommendations

```
GET /api/v1/catalog
→ [{ id, title, description, difficulty, category, ... }]  // published only
```

### LMS Recommendations — Used by: AI07 (as baseline to enhance)

```
GET /api/v1/courses/recommendations
→ string  // LMS's own recommendation engine output
```

```typescript
// AI07 strategy: get LMS recs, then enhance with AI reasons
const lmsRecs = await fetchFromLMS('/v1/courses/recommendations', env);
// If LMS recs are weak/basic → generate AI-powered recommendations
// If LMS recs are good → append AI "why this fits" explanations
```

### Learner Profile — Used by: AI06 Paths, AI07 Recommendations, AI09 Assistant

```
GET /api/v1/learner/profile
→ {
    id, name, email, role,
    gamification: {
      total_points, current_level, level_progress,
      login_streak, badges_earned, rank
    },
    learning_stats: {
      completed_courses, in_progress_courses,
      total_enrollments, average_completion_rate,
      certificates_earned
    }
  }
```

**Key insight:** This supersedes our planned AI05 Learner Profile Service. The LMS already tracks everything we planned to track (skills, progress, goals). Instead of building a separate profile service, the AI Workers read from this endpoint and enrich with AI-generated signals.

```typescript
// AI06 Paths Worker: richer input than originally planned
const profile = await fetchFromLMS('/v1/learner/profile', env);

// We get for free: gamification, completion rates, certificates
// This makes the prompt RICHER:
const promptContext = {
  skills: profile.learning_stats,        // what they've done
  motivation: profile.gamification,       // how engaged they are
  level: profile.gamification.current_level,
  streak: profile.gamification.login_streak,
};
```

### User Progress — Used by: AI06 Paths, AI07 Recs, AI08 Insights, AI09 Assistant

```
GET /api/v1/progress/user
→ {
    userId, totalEnrollments, activeEnrollments,
    completedEnrollments, averageProgress, totalTimeSpent,
    totalLessonsCompleted,
    enrollments: [{
      enrollmentId, courseId, courseTitle, courseCategory,
      status, progressPercent, startedAt, completedAt,
      lastActivity, timeSpent, completedLessons, totalLessons
    }]
  }
```

**Key insight:** Each enrollment includes `progressPercent`, `timeSpent`, and `completedLessons`. AI08 (Post-Quiz Insights) can use this to contextualize quiz performance — e.g., "You scored 60% but you've only completed 30% of the course — that's actually ahead of expected pace."

### My Enrollments — Used by: AI09 Assistant

```
GET /api/v1/enrollments/my-enrollments
→ [{ enrollmentId, courseId, status, ... }]
```

### Activity Summary — Used by: AI06 Paths, AI09 Assistant

```
GET /api/v1/learner/activity-summary
→ {
    recent_activities: [...],
    summary: {
      days_active, courses_in_progress,
      courses_completed, lessons_completed, total_time_spent
    },
    streaks: {
      current_login_streak, longest_login_streak,
      current_learning_streak
    },
    period: { days, start_date, end_date }
  }
```

**Key insight:** The `streaks` and `days_active` data can make recommendations more personal. "You've been learning every day this week — here's a challenging path to keep your momentum."

### Learner Assessments — Used by: AI08 Insights, AI11 Quality

```
GET /api/v1/learner/assessments
→ [{ id, title, courseId, status, score, ... }]

POST /api/v1/learner/assessments/{id}/submit
  body: {
    attemptId: string,
    responses: [{
      questionId, selectedOption, timeSpentSeconds
    }]
  }
```

**Key insight:** The LMS tracks `timeSpentSeconds` per question. AI08 can use this to identify hesitation patterns — "You spent 3x longer on questions about loops — this might be a topic to review."

### Skill Gaps — Used by: AI06 Paths, AI07 Recommendations

```
GET /api/v1/analytics/dashboard/skill-gaps
→ {
    organizationId,
    skillGapAnalysis: [...],
    recommendations: [...],
    generatedAt
  }
```

**Key insight:** The LMS already computes skill gaps. AI06 can use this as input instead of inferring gaps from enrollment data alone.

### Learner Preferences — Used by: AI06 Paths, AI07 Recs

```
GET /api/v1/learner/preferences
→ [...]  // learner settings, goals, interests
```

---

## Revised AI Worker Responsibilities

Given what the LMS already provides, each AI Worker's job narrows:

| Worker | Original Plan | What LMS Already Does | Worker's Actual Job |
|--------|--------------|----------------------|-------------------|
| **AI01a/b** Chunking/Indexing | Full pipeline | Stores lesson content | **Read** lessons → chunk → embed → index |
| **AI02** RAG Retrieval | Vector search | — | **Query** Vectorize with org scoping |
| **AI03** LLM Gateway | Model selection | — | **Call** Workers AI, enforce budget |
| **AI05** Learner Profile | Build profile service | Has full profile with gamification | **DELETE** — enrich LMS profile with AI signals instead |
| **AI04a** Tutor | Grounded Q&A | Stores lesson content | **Read** lessons + RAG → generate cited answers |
| **AI06** Learning Paths | Generate paths from profile | Has catalogue, progress, skill gaps, gamification | **Generate** AI-personalized paths using richer context |
| **AI07** Recommendations | AI recommendations | Has basic recommendations, catalogue, progress | **Enhance** LMS recs with AI "why this fits" explanations |
| **AI08** Post-Quiz Insights | Generate insights from quiz data | Full assessment results + time-per-question + course progress | **Generate** richer insights using time data + course context |
| **AI09** Platform Assistant | Platform Q&A | Has progress, activity, enrollments | **Answer** questions using live LMS data + AI |
| **AI10a** Question Generation | Generate from lesson | Has lesson content + assessments | **Generate** questions from lesson content via RAG + LLM |
| **AI10b** Approval Workflow | Approval state machine | Has admin dashboard + auth | **Manage** approval flow, integrate with LMS admin |
| **AI11** Quality Checks | Duplicates + reading level | Has assessment data | **Check** duplicates via Vectorize, reading level via LLM |
| **AI12** Fail Gracefully | Health + degradation | Has health endpoint | **Monitor** AI03 + LMS health, return degradation signals |

---

## What We DON'T Need to Build

1. **AI05 Learner Profile Service** — LMS already has `GET /v1/learner/profile` with richer data than we planned (gamification, streaks, learning stats). Instead, AI Workers enrich with AI-generated signals (skill inferences, learning style, motivation level).

2. **Separate progress tracking** — LMS tracks `progressPercent`, `timeSpent`, `completedLessons` per enrollment. AI features read this, not duplicate it.

3. **Separate recommendation engine** — LMS has its own (`/v1/courses/recommendations`). AI07 enhances it, doesn't replace it.

4. **Quiz result storage** — LMS stores full assessment submissions with per-question timing. AI08 reads from here, doesn't need quiz data in the request body.

---

## Integration Patterns

### Pattern 1: Read + Enrich
```
AI Worker fetches LMS data → runs through AI → returns enriched result
Used by: AI06, AI07, AI08
```

### Pattern 2: Read + Process + Store
```
AI Worker fetches LMS data → processes (chunk/embed/index) → stores in CF infra
Used by: AI01a/b Indexing pipeline
```

### Pattern 3: Read + Retrieve + Generate
```
AI Worker fetches LMS data → retrieves from Vectorize → generates via AI03 → returns
Used by: AI04a Tutor, AI09 Assistant, AI10a Question Gen
```

### Pattern 4: Store-only
```
AI Worker stores/manages its own data in D1/DO/KV
Used by: AI04b History (Durable Objects), AI10b Approval (D1)
```

---

## Authentication

All AI Workers use a single internal API key:

```typescript
// Shared utility in every AI Worker
async function fetchLMS(path: string, env: Env) {
  const url = `${env.LMS_GATEWAY_URL}/api${path}`;
  const res = await fetch(url, {
    headers: {
      'X-API-Key': env.LMS_INTERNAL_KEY,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`LMS API error: ${res.status} from ${path}`);
  }
  const json = await res.json<{ success: boolean; data: unknown }>();
  return json.data;
}
```

The LMS response format is consistent: `{ success: boolean, data: ..., message: string, timestamp: string }`. AI Workers extract `.data` and work with that.

---

## Summary: What Each AI Worker Calls

```
AI01a  → GET /v1/lessons/{id}           (content to chunk)
AI01b  → GET /v1/modules/{id}/lessons   (batch content to index)
AI02   → (calls Vectorize, no LMS calls)
AI03   → (calls Workers AI, no LMS calls [budget stored in D1])

AI04a  → GET /v1/lessons/{id}           (content for RAG context)
          POST /internal/generate        (AI03: LLM response)

AI06   → GET /v1/catalog                (all published courses)
          GET /v1/learner/profile        (skills, gamification, stats)
          GET /v1/progress/user          (enrollments, completion %)
          GET /v1/analytics/dashboard/skill-gaps  (org skill gaps)
          GET /v1/learner/activity-summary  (streaks, days active)
          POST /internal/generate        (AI03: LLM path generation)

AI07   → GET /v1/catalog                (courses)
          GET /v1/courses/recommendations (LMS baseline recs)
          GET /v1/learner/profile        (profile)
          GET /v1/progress/user          (enrollments)
          POST /internal/generate        (AI03: LLM-enhanced recs)

AI08   → GET /v1/learner/assessments/{id} (assessment + results)
          GET /v1/progress/user           (course progress context)
          POST /internal/generate         (AI03: LLM insight)

AI09   → GET /v1/progress/user           (progress)
          GET /v1/learner/activity-summary (activity)
          GET /v1/enrollments/my-enrollments (enrollments)
          GET /v1/lessons/{id}            (current lesson context)
          POST /internal/generate         (AI03: LLM response)

AI10a  → GET /v1/lessons/{id}           (lesson content)
          POST /internal/generate        (AI03 quality tier: question gen)

AI10b  → (stores in D1, no LMS calls for state machine)
          GET /v1/hr/assessments/{id}    (verify integration)

AI11   → GET /v1/courses/{id}            (course difficulty)
          (Vectorize for duplicate detection)
          POST /internal/generate         (AI03: reading level check)

AI12   → GET /v1/health                  (LMS health)
          (KV for health status)
          (AI03 health via Service Binding)

AI13   → Calls ALL AI Workers + LMS for demo dashboard
```
