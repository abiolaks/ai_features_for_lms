# LMS Endpoint Gaps — Phase 2 AI Features

> For the LMS backend team. What new endpoints and data fields are needed to unblock the Phase 2 AI features.
> **Date:** 2026-07-24

---

## Summary — Blockers at a Glance

| # | What's Needed | Blocks | Priority | Effort | Status |
|---|--------------|--------|----------|--------|--------|
| 1 | `skills`, `goals`, `experience_level`, `interests` on learner profile | F03a, F03b, F06 | 🔴 P0 | Small | ✅ Resolved — `GET /v1/learner/preferences` exists |
| 2 | `estimated_hours` on course catalogue | F03a | 🟡 P1 | Small | ✅ Resolved — `estimated_hours` field on `CourseResource` |
| 3 | Aggregate progress endpoint (admin) | F04a, F04b, F05 | 🟡 P1 | Medium | ⬜ Still needed |
| 4 | Aggregate quiz endpoint (admin) | F03b, F04a, F05 | 🟡 P1 | Medium | ✅ Resolved — `GET /v1/learner/assessments/summary` exists |
| 5 | Engagement analytics endpoint | F04b, F05 | 🟡 P1 | Large | ⬜ Still needed |
| 6 | Mentor directory endpoints | F02 | 🟢 P2 | Large | ✅ Resolved — `GET /v1/mentors`, `GET /v1/mentors/{id}` exist |
| 7 | Admin question ingestion endpoint | F09 | 🟢 P2 | Small | ✅ Resolved — `POST /v1/admin/questions/ingest` exists |

---

## Gap 1 — Learner Profile Fields 🔴 P0 ✅ Resolved

**Resolved by:** `GET /api/v1/learner/preferences` — returns `knownSkills`, `interests`, `learningGoal`, `skillLevel`, `preferredCategory`, `preferredDifficulty`, `preferredDuration`, `learningStyle`.

**Blocks:** F03a (Skill-Gap Analysis), F03b (Session Prep), F06 (Platform Assistant)

### What exists today

```
GET /api/v1/learner/preferences  ✅ Live
→ { knownSkills, interests, learningGoal, skillLevel, ... }
```

No LMS changes needed — AI workers can fetch preferences alongside profile.

---

## Gap 2 — Course `estimated_hours` Field 🟡 P1 ✅ Resolved

**Resolved by:** `CourseResource.estimated_hours` (number|null) and `estimatedDuration` (integer|null) exist in lmsapi.json.

**Blocks:** F03a (Skill-Gap Analysis)

---

## Gap 3 — Admin Aggregate Progress Endpoint 🟡 P1

**Blocks:** F04a (Bottleneck Detection), F04b (Engagement Monitoring), F05 (Admin Narratives)

### What we need

```
GET /api/v1/admin/progress/aggregate?org_id={org}&period=last_90_days
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

An endpoint that returns *pre-aggregated* progress data across all learners in an org. No individual learner data — the LMS does the aggregation server-side.

### Response shape

```json
{
  "success": true,
  "data": {
    "period": "last_90_days",
    "total_learners": 85,
    "modules": [
      {
        "module_id": "module-004",
        "module_title": "Advanced Algorithms",
        "course_id": "course-cs201",
        "course_title": "Computer Science 201",
        "median_completion_days": 14,
        "expected_completion_days": 7,
        "enrolled_learners": 42,
        "completed_learners": 18,
        "stalled_learners": 12
      }
    ],
    "overall": {
      "avg_completion_rate": 0.62,
      "avg_time_on_platform_minutes_per_week": 85,
      "courses_completed_this_period": 5
    }
  }
}
```

### Key fields explained

| Field | Purpose |
|-------|---------|
| `median_completion_days` | F04a compares to `expected_completion_days` — flags if >2× |
| `stalled_learners` | F03b, F04a — learners who started but haven't progressed in 14+ days |
| `enrolled_learners` | Needed for the <10 cohort suppression rule |
| `avg_completion_rate` | F05 narrative — "62% of learners are making progress" |

### Privacy requirement

**No individual learner data in the response.** All values are aggregates. Minimum cohort before returning data: 10 learners. If org has <10 learners in a module, return `null` for that module's stats.

### Without it

F04a, F04b, and F05 are completely blocked. These features need aggregate data — the AI worker cannot compute this from per-learner endpoints without fetching every learner's data, which is unscalable and a privacy violation.

---

## Gap 4 — Admin Aggregate Quiz Endpoint 🟡 P1 ✅ Partially Resolved

**Resolved (per-learner):** `GET /api/v1/learner/assessments/summary?userId=&organization_id=` exists — F03b session-prep uses this.

**Still needed (admin aggregate):** `GET /api/v1/admin/assessments/aggregate?org_id=&period=` for F04a/F05.

**Blocks:** F04a (Bottleneck Detection), F05 (Admin Narratives)

### What we need

```
GET /api/v1/admin/assessments/aggregate?org_id={org}&period=last_90_days
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

### Response shape

```json
{
  "success": true,
  "data": {
    "period": "last_90_days",
    "topics": [
      {
        "topic": "recursion",
        "avg_score_percent": 62,
        "total_attempts": 45,
        "below_benchmark": true,
        "benchmark": 70
      },
      {
        "topic": "sorting",
        "avg_score_percent": 88,
        "total_attempts": 38,
        "below_benchmark": false,
        "benchmark": 70
      }
    ],
    "overall": {
      "avg_quiz_score": 74,
      "total_quizzes_completed": 120,
      "score_trend": "up"
    }
  }
}
```

### Per-learner quiz summary (for F03b only)

F03b also needs *per-learner* quiz summaries to generate session agendas. This could be an extension of the existing assessment endpoints:

```
GET /api/v1/learner/assessments/summary?userId={learner_id}
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

```json
{
  "success": true,
  "data": {
    "total_attempts": 8,
    "avg_score_percent": 72,
    "lowest_topic": "recursion",
    "lowest_topic_score": 45,
    "recent_attempts": [
      {
        "assessment_title": "Functions Quiz",
        "score_percent": 55,
        "topic": "functions",
        "completed_at": "2026-07-20T10:00:00Z"
      }
    ]
  }
}
```

### Privacy (aggregate endpoint)

Same as Gap 3 — no individual data, <10 learner suppression.

### Without it

- F03b can't identify "lowest quiz topic" — agenda becomes generic
- F04a can't detect topic-level bottlenecks
- F05 can't report quiz score trends

---

## Gap 5 — Engagement Analytics Endpoint 🟡 P1

**Blocks:** F04b (Engagement Monitoring), F05 (Admin Narratives)

### What we need

```
GET /api/v1/admin/engagement?org_id={org}&period=last_30_days
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

### Response shape

```json
{
  "success": true,
  "data": {
    "period": "last_30_days",
    "active_learners": 85,
    "video_analytics": {
      "avg_completion_rate_percent": 58,
      "drop_off_threshold_seconds": 900,
      "videos_above_threshold": [
        {
          "lesson_id": "lesson-vid-042",
          "lesson_title": "Deep Dive: Neural Networks",
          "duration_seconds": 2400,
          "avg_watch_percent": 35,
          "drop_off_seconds": 900
        }
      ]
    },
    "activity_patterns": {
      "peak_day": "Tuesday",
      "low_day": "Friday",
      "peak_hour_utc": 14,
      "avg_sessions_per_week": 3.2
    },
    "completion_rates": {
      "courses_started": 12,
      "courses_completed": 3,
      "avg_module_completion_percent": 62
    }
  }
}
```

### Key fields explained

| Field | Purpose |
|-------|---------|
| `drop_off_threshold_seconds` | F04b — at what second do viewers typically abandon? |
| `videos_above_threshold` | F04b — specific videos needing chunking/shorter format |
| `activity_patterns` | F04b/F05 — when are learners most/least active? |
| `peak_day` / `low_day` | F04b — schedule live sessions on peak days |

### Privacy

Aggregate only. No per-learner watch data. <10 learner suppression.

### Without it

F04b Engagement Monitoring is blocked — the core data (video drop-off, activity patterns) doesn't exist anywhere the AI worker can reach.

---

## Gap 6 — Mentor Directory 🟢 P2 ✅ Resolved

**Resolved by:** `GET /api/v1/mentors` and `GET /api/v1/mentors/{id}` exist in lmsapi.json.

**Blocks:** F02 (Mentor Matching)

### What we need

This is a **new data product** — a directory of mentors with profiles, skills, and availability. Two endpoints:

#### 6a. List mentors in org

```
GET /api/v1/mentors?org_id={org}
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

```json
{
  "success": true,
  "data": [
    {
      "id": "mentor-001",
      "name": "Dr. Sarah Chen",
      "specializations": ["python", "algorithms", "machine-learning"],
      "experience_levels": ["beginner", "intermediate"],
      "availability": ["weekday_evenings", "weekend_mornings"],
      "bio": "Senior ML engineer with 8 years mentoring experience",
      "past_mentee_count": 12,
      "avg_mentee_rating": 4.8,
      "org_id": "org-wragby"
    }
  ]
}
```

#### 6b. Single mentor detail

```
GET /api/v1/mentors/{id}
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

Same shape as above, single object.

### LMS responsibilities for this

- Data model: mentor profiles with skills, availability, track record
- Admin UI: add/edit/remove mentors
- Mentor signup flow (if self-service)
- Availability management (calendar integration?)
- Mentee outcome tracking (optional — enables the "success record" scoring signal)

### Without it

F02 Mentor Matching is completely blocked — the AI worker has no mentor data to match against.

---

## Gap 7 — Admin Question Ingestion Endpoint 🟢 P2 ✅ Resolved

**Resolved by:** `POST /api/v1/admin/questions/ingest` exists in lmsapi.json.

**Blocks:** F09 (Assessment Approval Workflow) — LMS side of the split

### What we need

When an admin approves AI-generated questions, the LMS needs a way to receive them:

```
POST /api/v1/admin/questions/ingest
Header: X-API-Key: <LMS_INTERNAL_KEY>
```

```json
{
  "questions": [
    {
      "id": "q-abc123",
      "text": "What does the `len()` function return?",
      "options": {
        "A": "The type of an object",
        "B": "The length of an object",
        "C": "The memory address",
        "D": "The first element"
      },
      "correct_answer": "B",
      "difficulty": "beginner",
      "topic": "python-builtins",
      "lesson_id": "lesson-python-101",
      "course_id": "course-py",
      "org_id": "org-wragby"
    }
  ]
}
```

### AI worker endpoints the LMS calls

The LMS admin dashboard calls these AI worker endpoints (already built or planned as part of F09):

| Endpoint | Purpose |
|----------|---------|
| `GET /questions/pending?org_id=` | List questions awaiting review |
| `POST /questions/{id}/status` | Approve/reject a question |
| `POST /questions/store` | Save generated questions (called by F07, not LMS) |

### LMS responsibilities for F09

- Admin UI: review panel showing questions in context (source lesson)
- Admin UI: approve/reject/edit actions
- Admin UI: bulk approve workflow
- Backend: call AI worker endpoints from admin panel
- Backend: ingest approved questions into the LMS quiz engine (`POST /api/v1/admin/questions/ingest`)

---

## Existing Endpoints — Confirmed Live ✅

These already exist and work. No changes needed.

| Endpoint | Used by |
|----------|---------|
| `GET /api/v1/learner/profile` | F03a, F03b, F06 |
| `GET /api/v1/catalog` | F03a, F06 |
| `GET /api/v1/public/courses` | Fallback catalogue |
| `GET /api/v1/progress/user` | F03a, F03b |
| `GET /api/v1/lessons/{id}` | F06, F07 |
| `GET /api/v1/learner/assessments/{id}` | F03b |
| `GET /api/v1/learner/assessments/attempts/{id}` | F03b |
| `GET /api/v1/modules/{moduleId}/lessons` | F06 |
| `GET /api/v1/health` | All workers |

---

## Build Order Recommendation

```
Week 1-2:  Gap 1 (profile fields)    — unblocks 3 features, smallest effort
           Gap 2 (estimated_hours)   — 1 field, unblocks F03a

Week 3-4:  Gap 3 (aggregate progress) — unblocks F04a, F04b, F05
           Gap 4 (aggregate quiz)     — unblocks F03b, F04a, F05

Week 5-6:  Gap 5 (engagement)         — unblocks F04b, F05

Week 7+:   Gap 6 (mentor directory)   — new data product, needs design
           Gap 7 (question ingestion) — depends on F07+F08 being built first
```

---

## Quick Summary for LMS Engineer

> 3 new endpoints, 1 endpoint modification, 2 field additions, 1 new data product.

| Type | What | Count |
|------|------|-------|
| Modify existing | Add `skills`, `goals`, `experience_level`, `interests` to profile | 1 |
| Add field | `estimated_hours` to catalogue | 1 |
| New endpoint | `GET /api/v1/admin/progress/aggregate` | 1 |
| New endpoint | `GET /api/v1/admin/assessments/aggregate` | 1 |
| New endpoint | `GET /api/v1/learner/assessments/summary` | 1 |
| New endpoint | `GET /api/v1/admin/engagement` | 1 |
| New endpoint | `POST /api/v1/admin/questions/ingest` | 1 |
| New data product | Mentor directory + `GET /api/v1/mentors` | 1 |

All auth: `X-API-Key: <LMS_INTERNAL_KEY>` (same as existing). All responses: `{ success: true, data: {...} }` wrapper (same convention).


F03b Session Prep Insights — LMS Endpoint Request

 Context: We're building POST /mentor/session-prep — a feature that generates a 3-topic
 session agenda for mentors before they meet learners. It analyzes recent activity, quiz
 performance, and stalled progress to prioritize what to discuss.

 Auth: Same X-API-Key: <LMS_INTERNAL_KEY> header as all existing AI-to-LMS calls.

 ────────────────────────────────────────────────────────────────────────────────

 ### Request A: List learner's recent assessments (P0 — blocker)

 ```
   GET
 /v1/learner/assessments?userId=<id>&status=completed&sort=completed_at:desc&limit=5
   Header: X-API-Key: <LMS_INTERNAL_KEY>
 ```

 This is the single missing piece. We need to know what quizzes a learner has taken
 recently and how they scored, so we can identify the lowest-performing topic for the
 mentor to focus on.

 The path /v1/learner/assessments already exists as POST (start a new assessment). This
 would add a GET to the same path for listing.

 Response shape:

 ```json
   {
     "success": true,
     "data": [
       {
         "id": "019f121f-...",
         "title": "Recursion Basics Quiz",
         "courseId": "019f0513-...",
         "moduleId": "019f121d-...",
         "scorePercent": 45,
         "totalQuestions": 5,
         "correctAnswers": 2,
         "status": "completed",
         "completedAt": "2026-07-23T14:30:00Z"
       }
     ]
   }
 ```

 Fields we use:

 ┌────────────────────┬───────────────────────────────────────┐
 │ Field              │ Purpose                               │
 ├────────────────────┼───────────────────────────────────────┤
 │ id                 │ Fetch full attempt detail if needed   │
 ├────────────────────┼───────────────────────────────────────┤
 │ title              │ Extract topic name for agenda item    │
 ├────────────────────┼───────────────────────────────────────┤
 │ courseId, moduleId │ Build lesson links for prep materials │
 ├────────────────────┼───────────────────────────────────────┤
 │ scorePercent       │ Sort by lowest → highest (urgency)    │
 ├────────────────────┼───────────────────────────────────────┤
 │ completedAt        │ Ensure recency                        │
 └────────────────────┴───────────────────────────────────────┘

 Query params:

 ┌────────┬────────┬─────────────────────┬──────────────────┐
 │ Param  │ Type   │ Default             │ Notes            │
 ├────────┼────────┼─────────────────────┼──────────────────┤
 │ userId │ string │ required            │ Learner ID       │
 ├────────┼────────┼─────────────────────┼──────────────────┤
 │ status │ string │ "completed"         │ Filter by status │
 ├────────┼────────┼─────────────────────┼──────────────────┤
 │ sort   │ string │ "completed_at:desc" │ Ordering         │
 ├────────┼────────┼─────────────────────┼──────────────────┤
 │ limit  │ int    │ 5                   │ Max results      │
 └────────┴────────┴─────────────────────┴──────────────────┘

 ────────────────────────────────────────────────────────────────────────────────

 ### Request B: Accept ?userId= on /v1/learner/profile (P1 — nice to have)

 ```
   GET /v1/learner/profile?userId=<id>
   Header: X-API-Key: <LMS_INTERNAL_KEY>
 ```

 Currently the profile endpoint returns the caller's own profile (resolved from auth
 context). But AI workers call with a service-level key, not per-user credentials.
 Passing ?userId= explicitly lets us fetch any learner's profile for the mentor view.

 If this is a heavy lift, we can work around it by combining /v1/learner/preferences +
 /v1/progress/user?userId= — so this is P1, not P0.

 ────────────────────────────────────────────────────────────────────────────────

 ### What we don't need

 - ✗ No new attempt-level endpoints — we'll reuse existing GET
   /v1/learner/assessments/attempts/{attemptId} if needed
 - ✗ No lesson/module changes — existing /v1/courses/{courseId}/modules and
   /v1/modules/{moduleId}/lessons cover prep material links
 - ✗ No new auth mechanism — same X-API-Key pattern


These are in the issues but have no corresponding endpoint in api.json:

 ┌─────────────────────────┬─────────────────────┬─────────────────────────────────────┐
 │ Missing data            │ Needed for          │ New endpoint suggestion             │
 ├─────────────────────────┼─────────────────────┼─────────────────────────────────────┤
 │ Per-module completion   │ F04a — "median time │ GET                                 │
 │ times                   │ to complete module  │ /v1/admin/module-progress?org_id=X& │
 │                         │ X"                  │ period=90d                          │
 ├─────────────────────────┼─────────────────────┼─────────────────────────────────────┤
 │ Per-module quiz score   │ F04a — "quiz scores │ GET                                 │
 │ distributions           │ dropped in module   │ /v1/admin/module-assessments?org_id │
 │                         │ 4"                  │ =X                                  │
 ├─────────────────────────┼─────────────────────┼─────────────────────────────────────┤
 │ Per-video watch rates + │ F04b — "video       │ GET                                 │
 │ drop-off timestamps     │ completion drops    │ /v1/admin/video-analytics?org_id=X& │
 │                         │ 40% after 15 mins"  │ period=30d                          │
 ├─────────────────────────┼─────────────────────┼─────────────────────────────────────┤
 │ Session duration /      │ F04b — "how long    │ Add averageSessionMinutes to        │
 │ time-on-platform        │ are learners        │ dashboard, or new endpoint          │
 │                         │ actually spending"  │                                     │
 └─────────────────────────┴─────────────────────┴─────────────────────────────────────┘


  ### Missing entirely (not in api.json at all)

 ┌──────────────────────────┬──────────────────────────────────────────────────────────┐
 │ What F04a/F04b need      │ Why missing                                              │
 ├──────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Per-module completion    │ All admin endpoints are org-level aggregates. F04a needs │
 │ times (F04a)             │ median completion time per module to flag "2× slower     │
 │                          │ than expected."                                          │
 ├──────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Per-module quiz score    │ Same — needs per-module quiz score distributions to      │
 │ trends (F04a)            │ surface topic-level bottlenecks.                         │
 ├──────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Video watch rates /      │ No video analytics endpoint exists. F04b needs "video    │
 │ drop-off timestamps      │ completion drops 40% after 15 min" — requires per-video  │
 │ (F04b)                   │ watch data with timestamp-level granularity.             │
 ├──────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Time-on-platform per     │ Dashboard/login-trends give login counts, not session    │
 │ learner (F04b)           │ duration / time-on-platform.                             │
 ├──────────────────────────┼──────────────────────────────────────────────────────────┤
 │ Per-course video         │ F04b needs "which videos are being abandoned" — requires │
 │ completion breakdown     │ per-video completion rate data.                          │
 │ (F04b)                   │                                                          │
 └──────────────────────────┴──────────────────────────────────────────────────────────┘

 ### 4. Auth question

 Do these admin endpoints derive org_id from the X-API-Key context, or should we pass it
 as a query param? None of them have org_id in their parameter lists in api.json.
