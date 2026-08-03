# LMS Integration Guide

> For the LMS Team. How to integrate with the 13 deployed AI workers.

---

## Before You Start: 3 Secrets

| Secret | Who creates it | Who uses it | Purpose |
|--------|---------------|-------------|---------|
| `LMS_GATEWAY_URL` | LMS team → share with AI team | AI Workers | Your base URL for REST calls |
| `LMS_INTERNAL_KEY` | LMS team → share with AI team | AI Workers → LMS | Auth header: `X-API-Key` |
| `LMS_WEBHOOK_SECRET` | AI team → share with LMS team | LMS → ai-indexing | Auth header: `X-Webhook-Secret` |

---

## What the LMS Needs to Build

### 1. Backend: REST API Endpoints

All AI Workers call the LMS to fetch data. Auth: `X-API-Key: <LMS_INTERNAL_KEY>`. All return `{ "success": true, "data": ... }`.

#### Learner Data Endpoints

| Endpoint | Used by | Returns |
|----------|---------|---------|
| `GET /api/v1/health` | All workers | `{ "status": "ok" }` |
| `GET /api/v1/learner/profile?user_id=<uuid>` | paths, recs, mentor, assistant, insights | `{ data: { id, learning_stats, gamification } }` |
| `GET /api/v1/learner/preferences` | paths, mentor | `{ data: { knownSkills, interests, learningGoal, skillLevel, preferredCategory } }` |
| `GET /api/v1/catalog?organization_id=<uuid>&per_page=100` | paths, recs, mentor | `{ data: [{ id, title, category, difficultyLevel, skillsCovered, prerequisites }] }` |
| `GET /api/v1/progress/user?userId=<uuid>` | paths, recs, insights, mentor | `{ data: { totalEnrollments, completedEnrollments, enrollments: [{ courseTitle, status, progressPercent }] } }` |
| `GET /api/v1/lessons/{id}` | tutor, question-gen | `{ data: { id, title, content, courseId, moduleId } }` |
| `GET /api/v1/learner/assessments/{id}` | insights | `{ data: { id, title, courseId, moduleId } }` |
| `GET /api/v1/learner/assessments/attempts/{id}` | insights | `{ data: { id, userId, assessmentId, scorePercent, totalQuestions, correctAnswers, responses: [...] } }` |
| `GET /api/v1/modules/{moduleId}/lessons` | insights | `{ data: [{ id, title, sortOrder }] }` |
| `GET /api/v1/learner/assessments/summary?userId=<uuid>&organization_id=<uuid>` | insights (session-prep) | `{ data: { total_attempts, avg_score_percent, lowest_topic, lowest_topic_score } }` |

#### Admin Data Endpoints (for analytics, bottlenecks, engagement)

| Endpoint | Used by | Returns |
|----------|---------|---------|
| `GET /api/v1/admin/progress/aggregate?organization_id=<uuid>&period=<period>` | bottlenecks, analytics | Module-level completion stats: median/expected days, enrolled/stalled/completed learners per module |
| `GET /api/v1/admin/assessments/aggregate?organization_id=<uuid>&period=<period>` | bottlenecks, analytics | Per-topic quiz scores: avg score, attempts, trends |
| `GET /api/v1/admin/engagement?organization_id=<uuid>&period=<period>` | engagement, analytics | Video watch %/drop-off, course stall rates, activity patterns by hour/day |

Supported `period` values: `last_7_days`, `last_30_days`, `last_90_days`, `last_year`.

### 2. Backend: Call These Webhooks

Call the AI indexing worker when content changes. Auth: `X-Webhook-Secret: <shared-secret>`.

**POST /index** — when a lesson is published or updated:
```
POST https://ai-indexing.yomi-alarape.workers.dev/index
X-Webhook-Secret: <secret>

{ "event": "publish", "org_id": "<uuid>",
  "entity": { "id": "<uuid>", "title": "...", "contentType": "video|pdf|pptx",
              "course_id": "<uuid>", "module_id": "<uuid>",
              "cloudflareVideoId": "<stream-uid>" } }
```
→ `202 { "status": "queued" }`

**POST /deindex** — when a lesson is deleted or unpublished:
```
POST https://ai-indexing.yomi-alarape.workers.dev/deindex
X-Webhook-Secret: <secret>

{ "event": "unpublish", "org_id": "<uuid>",
  "entity": { "id": "<uuid>" } }
```
→ `200 { "status": "deindexed", "vectors_removed": 3 }`

For PDF/PPTX: use `"contentType": "pdf"` and include `"r2Key"` or inline `"content"`. Video uses `"cloudflareVideoId"`.

### 3. Frontend: Embed These AI Widgets

Every request includes `learner_id` and `org_id`. No auth required currently.

#### Learner-Facing Widgets

| Widget | Endpoint | When | Input | Key response fields |
|--------|----------|------|-------|---------------------|
| **Tutor** | `POST /tutor/ask` | Lesson Q&A | `question`, `learner_id`, `lesson_id`, `course_id`, `org_id`, `expand_scope?` | `answer`, `citations[{ lesson_title, excerpt, score }]`, `scope_expansion_suggested`, `history_length` |
| | `POST /tutor/clear` | New conversation / logout | `learner_id` | `status` |
| **Learning Paths** | `POST /paths/generate` | "My Path" page | `learner_id`, `org_id` | `path[{ course_title, order, why_this_fits }]`, `ai_status` |
| **Recommendations** | `POST /recommendations/dashboard` | "For You" widget | `learner_id`, `org_id`, `refresh?` | `recommendations[{ course_title, ai_why_this_fits, score, fit_level }]`, `ai_status`, `source` |
| | `POST /recommendations/next` | After course completion | `learner_id`, `org_id`, `course_id` | `next_courses[{ course_title, why_this_fits, score, fit_level }]`, `ai_status` |
| **Assistant** | `POST /assistant/ask` | Platform-wide search | `question`, `learner_id`, `org_id` | `answer`, `citations[{ lesson_title, course_id, excerpt, score }]`, `suggested_courses[{ title, course_id, reason }]`, `history_length` |
| | `POST /assistant/clear` | New conversation / logout | `learner_id` | `status` |
| **Quiz Insights** | `POST /insights/generate` | After quiz submission | `learner_id`, `org_id`, `attempt_id`, `assessment_id` | `insight{ summary, strengths }`, `review_links[{ lesson_title, url }]`, `ai_status` |
| **Mentor** | `POST /mentor/session-prep` | Before mentor 1-on-1 | `learner_id`, `mentor_id`, `org_id` | `recent_activity`, `suggested_agenda[{ topic, reason, duration_min }]`, `prep_materials`, `ai_status` |
| | `GET /mentor/skill-gap` | Learner dashboard | `learner_id`, `org_id` (query params) | `learner_skills`, `gaps[{ skill, current_level, required_level, courses_available, estimated_hours }]`, `summary` |

URLs:

| Worker | Base URL | Conversation state |
|--------|----------|--------------------|
| Tutor | `https://ai-tutor.yomi-alarape.workers.dev` | Per learner + course (Durable Object, max 20 messages) |
| Assistant | `https://ai-assistant.yomi-alarape.workers.dev` | Per learner (Durable Object, max 20 messages) |
| Learning Paths | `https://ai-paths.yomi-alarape.workers.dev` | Stateless |
| Recommendations | `https://ai-recommendations.yomi-alarape.workers.dev` | Stateless (24h KV cache) |
| Quiz Insights | `https://ai-insights.yomi-alarape.workers.dev` | Stateless |
| Mentor (skill-gap) | `https://mentor.yomi-alarape.workers.dev` | Stateless |
| Mentor (session-prep) | `https://ai-insights.yomi-alarape.workers.dev` | Stateless |

#### Content Authoring Widgets

| Widget | Endpoint | When | Input | Key response fields |
|--------|----------|------|-------|---------------------|
| **Question Gen** | `POST /questions/generate` | Instructor creates quiz from lesson | `lesson_id`, `org_id`, `count?`, `type?` | `questions[{ text, options, correct_answer, difficulty, topic }]`, `content_source`, `ai_status` |
| **Quality Check** | `POST /questions/validate` | Validate generated questions | `questions[{ text, options, correct_answer, difficulty, topic, source_content }]` | `total`, `passed`, `failed`, `results[{ passed, issues[], suggestions[] }]`, `ai_status` |

URLs:

| Worker | Base URL |
|--------|----------|
| Question Gen | `https://ai-question-gen.yomi-alarape.workers.dev` |
| Quality Check | `https://ai-quality.yomi-alarape.workers.dev` |

`type`: `"multiple-choice"` (default) or `"true-false"`. `count`: 1–15 (default 5).

#### Admin Widgets

| Widget | Endpoint | When | Input | Key response fields |
|--------|----------|------|-------|---------------------|
| **Bottlenecks** | `GET /admin/bottlenecks` | Admin dashboard | `org_id`, `period` (query params) | `bottlenecks[{ module, course, metric, expected, actual, affected_learners, suggestion }]`, `summary`, `ai_status` |
| **Engagement** | `GET /admin/engagement` | Admin dashboard | `org_id`, `period` (query params) | `patterns[{ type, severity, title, affected_learners, suggestion }]`, `summary`, `metrics`, `ai_status` |
| **Narratives** | `GET /admin/narrative` | Admin dashboard | `org_id`, `period` (query params) | `narrative`, `highlights[{ text, type }]`, `metrics{ ... }`, `comparisons[{ metric, current, previous, change, direction }]`, `ai_status` |

URLs:

| Worker | Base URL |
|--------|----------|
| Bottlenecks | `https://ai-bottlenecks.yomi-alarape.workers.dev` |
| Engagement | `https://ai-engagement.yomi-alarape.workers.dev` |
| Narratives | `https://ai-analytics.yomi-alarape.workers.dev` |

---

## How ai_status Works

Every widget returns `ai_status` — use it to handle degraded states:

| ai_status | Meaning | What to show |
|-----------|---------|--------------|
| `generated` / `enhanced` | AI working normally | Full AI-powered content |
| `degraded` | LLM/Gateway down, stub returned | Show stub content, no retry |
| `unavailable` | No data at all | Empty state message |
| `insufficient_data` | Learner profile incomplete | Prompt user to fill in skills/goals |

Workers never throw 5xx errors. Check `ai_status` on every response.

---

## Checklist

**Secrets:**
- [ ] Share `LMS_GATEWAY_URL` with AI team
- [ ] Pick `LMS_INTERNAL_KEY` and share with AI team
- [ ] Receive `LMS_WEBHOOK_SECRET` from AI team

**Backend — Learner endpoints (validate `X-API-Key`):**
- [ ] `GET /api/v1/health`
- [ ] `GET /api/v1/learner/profile`
- [ ] `GET /api/v1/learner/preferences`
- [ ] `GET /api/v1/catalog` (support `?per_page=100`)
- [ ] `GET /api/v1/progress/user?userId=<id>`
- [ ] `GET /api/v1/lessons/{id}`
- [ ] `GET /api/v1/learner/assessments/{id}`
- [ ] `GET /api/v1/learner/assessments/attempts/{id}`
- [ ] `GET /api/v1/modules/{moduleId}/lessons`
- [ ] `GET /api/v1/learner/assessments/summary?userId=<uuid>&organization_id=<uuid>`

**Backend — Admin endpoints (validate `X-API-Key`):**
- [ ] `GET /api/v1/admin/progress/aggregate?organization_id=<uuid>&period=<period>`
- [ ] `GET /api/v1/admin/assessments/aggregate?organization_id=<uuid>&period=<period>`
- [ ] `GET /api/v1/admin/engagement?organization_id=<uuid>&period=<period>`

**Backend — Webhooks:**
- [ ] `POST /index` when lesson is published/updated
- [ ] `POST /deindex` when lesson is deleted/unpublished

**Frontend — Learner widgets:**
- [ ] Tutor — `POST /tutor/ask` + `POST /tutor/clear`
- [ ] Learning Paths — `POST /paths/generate`
- [ ] Recommendations — `POST /recommendations/dashboard` + `POST /recommendations/next`
- [ ] Assistant — `POST /assistant/ask` + `POST /assistant/clear`
- [ ] Quiz Insights — `POST /insights/generate`
- [ ] Mentor — `POST /mentor/session-prep` + `GET /mentor/skill-gap`

**Frontend — Authoring widgets:**
- [ ] Question Gen — `POST /questions/generate`
- [ ] Quality Check — `POST /questions/validate`

**Frontend — Admin widgets:**
- [ ] Bottlenecks — `GET /admin/bottlenecks`
- [ ] Engagement — `GET /admin/engagement`
- [ ] Narratives — `GET /admin/narrative`
