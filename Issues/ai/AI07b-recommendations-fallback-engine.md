# AI07b: Fallback Recommendation Engine

- **Type:** Contingency — only build if LMS recommendations are missing/insufficient
- **Week:** 5 (parallels AI07 Enhanced Recs)
- **Depends on:** AI03 (LLM Gateway), LMS `/api/v1/catalog`, `/api/v1/learner/profile`, `/api/v1/progress/user`, `/api/v1/analytics/dashboard/skill-gaps`
- **PR target:** ~350 lines (Worker + D1 schema + tests)
- **Activation condition:** LMS `GET /api/v1/courses/recommendations` returns empty, errors, or generic results

---

## Background

The LMS API contract (`api.json`) declares `GET /api/v1/courses/recommendations` but its response schema is `{ success: boolean, data: string }` — the `data: string` is vague and may be:

1. **A working engine** returning JSON-encoded recommendations (best case — AI07 just enhances)
2. **A placeholder** returning empty or hardcoded results (worst case — we build this)
3. **A partial engine** returning simple recs without personalization (middle case — we supplement)

If cases 2 or 3 are true, AI07's fallback cascade ("generate recs from catalogue alone via AI03") would be the only path, and it's too basic for a production recommendation system. This document defines what a proper fallback engine would look like.

---

## Recommendation Strategy: Multi-Signal Hybrid

We combine four signals — content similarity, collaborative filtering, skill-gap fill, and AI scores — into a single ranked list. No signal alone is sufficient; together they produce personalized recs.

### Signal 1: Content-Based (Vectorize)
**What:** "Courses similar to what you've completed"
**How:** Search Vectorize `{org_id}-courses` index with learner's completed course topics as query (embedded via Workers AI `@cf/qwen/qwen3-embedding-0.6b`) → Vectorize returns nearest unenrolled courses via cosine similarity.
**Strength:** Always available. Works for cold-start learners with at least one completed course. Embeddings run on Cloudflare's edge — no separate embedding service needed.

```
Learner completed "Python Fundamentals" + "Intro to Data"
→ Embed combined description → query Vectorize courses index
→ Cosine similarity returns "Advanced Python" (score 0.92), "Data Structures" (0.89)
```

### Signal 2: Collaborative ("Learners Like You")
**What:** "Courses popular with similar learners"
**How:** Store enrollment patterns in D1 → query: "for learners with same skill level + same completed courses → what did they enroll in next?"
**Strength:** Captures real-world learning paths. Improves as data grows.

```
D1 table: learner_profile_vectors
Columns: org_id, learner_id, skill_level, completed_course_ids (JSON array), next_enrollments (JSON array)

Query: WHERE skill_level = 'beginner' AND completed_course_ids contains 'python-basics'
→ returns Stats: {"data-analysis-101": 47 enrollments, "web-scraping": 32 enrollments, ...}
```

### Signal 3: Skill-Gap Fill (LMS Analytics)
**What:** "Courses that fill your or your org's skill gaps"
**How:** Read skill gaps from `GET /api/v1/analytics/dashboard/skill-gaps` → filter catalog for courses tagged with those skills.
**Strength:** Directly addresses weaknesses. Org-level gaps add team context.

```
LMS skill gaps: ["error-handling", "async-python", "decorators"]
→ Filter catalog by skill tags → "Advanced Error Patterns", "AsyncIO Deep Dive", "Python Metaprogramming"
```

### Signal 4: AI Scoring (AI03 Gateway)
**What:** "AI ranks the candidate courses by personal fit"
**How:** Take top N candidates from signals 1-3 → send to AI03 with learner profile + course details → AI returns ranked list with scores and reasons.
**Strength:** Captures nuance the other signals miss (learning style, motivation, career goals).

```
Prompt:
"You are a curriculum advisor. Given this learner profile and these candidate courses,
rank them by fit and explain why each is a good or bad fit in one sentence.

Learner: { skills, goals, completed_courses, login_streak, learning_stats }
Candidates: [{ title, difficulty, category, skills_taught }, ...]

Return JSON: [{ course_id, score (0-100), reason, fit_level: 'strong'|'moderate'|'weak' }]"
```

---

## UX: Where Recommendations Appear

Recommendations are not a destination page — they're an **embedded component** rendered on multiple pages. The LMS frontend calls the Worker depending on what page it's rendering:

```
Learner logs in
     │
     ▼
┌─ DASHBOARD ────────────────────────────┐
│  Recommended for you                   │
│  (personalized to this learner)        │ ← GET /recommendations
└────────────────────────────────────────┘
     │
     │ clicks a course
     ▼
┌─ COURSE DETAIL PAGE ───────────────────┐
│  Similar courses                       │
│  "If you like Python Basics, try..."   │ ← GET /recommendations/similar
└────────────────────────────────────────┘
     │
     │ finishes the course
     ▼
┌─ COURSE COMPLETE PAGE ─────────────────┐
│  🎉 Congratulations!                   │
│  What's next?                          │ ← GET /recommendations/next
└────────────────────────────────────────┘
```

Three contexts, three different recommendation strategies:

| Context | Endpoint | What it means | Dominant signals |
|---------|----------|---------------|-----------------|
| Dashboard | `/recommendations` | "What should this person learn?" | All 4, full personalization |
| Course page | `/recommendations/similar` | "What's similar to this course?" | Content (Vectorize) + collaborative |
| Completion | `/recommendations/next` | "What builds on this course?" | Prerequisite chain + collaborative + skill gaps |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                AI07b Recommendations Worker                   │
│                                                               │
│  GET /recommendations?learner_id={id}&org_id={id}            │
│  GET /recommendations/similar?course_id={id}&org_id={id}     │
│  GET /recommendations/next?learner_id={id}&course_id={id}    │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 1. Check KV cache → hit: return immediately            │  │
│  │ 2. Fetch learner: profile + progress + skill gaps      │  │
│  │ 3. Parallel signal computation:                        │  │
│  │    ├── Signal 1: Content-based (Vectorize)             │  │
│  │    ├── Signal 2: Collaborative (D1 query)              │  │
│  │    └── Signal 3: Skill-gap fill (catalog filter)       │  │
│  │ 4. Merge + deduplicate candidates                      │  │
│  │ 5. Signal 4: AI scoring via AI03 Gateway               │  │
│  │ 6. Blend scores: weighted average of all signals       │  │
│  │ 7. Cache in KV: 24h TTL                                │  │
│  │ 8. Return ranked recommendations                       │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
         │                │                │
         ▼                ▼                ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Vectorize│    │    D1     │    │ AI03 GW  │
    │(courses) │    │ (SQLite)  │    │(Workers AI)│
    └──────────┘    └──────────┘    └──────────┘
```

---

## Scoring Formula

```
final_score = (content_score × 0.25) + (collab_score × 0.20) + (skill_gap_score × 0.20) + (ai_score × 0.35)
```

| Signal | Weight | Rationale |
|--------|--------|-----------|
| AI score | 35% | Captures personal fit nuance the others miss |
| Content similarity | 25% | Strong signal for "next logical course" |
| Skill gap fill | 20% | Directly addresses learner weaknesses |
| Collaborative | 20% | Helps discover unexpected but proven paths |

Weights are configurable via Worker env vars: `REC_WEIGHT_CONTENT`, `REC_WEIGHT_COLLAB`, `REC_WEIGHT_SKILL_GAP`, `REC_WEIGHT_AI`.

---

## API Contract

All three endpoints return the same response shape. The difference is in which signals are weighted and what data is fed to the engine.

### `GET /recommendations?learner_id={id}&org_id={id}&limit={n}`

**Use:** Dashboard / home page widget. Personalized to the specific learner.
**Weighting:** Full 4-signal blend (25/20/20/35).

### `GET /recommendations/similar?course_id={id}&org_id={id}&limit={n}`

**Use:** Course detail page — "If you like this, try these."
**Weighting:** Content-biased (50/30/0/20). No skill-gap signal — learner is browsing, not filling gaps. Content similarity (Vectorize) is the dominant signal. Collaborative adds "others who took this also took..."

### `GET /recommendations/next?learner_id={id}&org_id={id}&course_id={id}`

**Use:** Course completion page — "What's next after this course?"
**Weighting:** Progression-biased (30/35/20/15). Collaborative is dominant (what did similar learners take next?). Difficulty is one step harder than the completed course. Prerequisite chain respected: courses that list the completed course as a prerequisite score higher.

### Response (all endpoints)

```json
{
  "recommendations": [
    {
      "course_id": "adv-python-101",
      "course_title": "Advanced Python Patterns",
      "score": 94,
      "signals": {
        "content_similarity": 0.88,
        "collaborative": 42,
        "skill_gap_match": true,
        "ai_score": 92
      },
      "reasons": [
        "You completed Python Fundamentals with 92% — this is the natural next step",
        "85% of learners with your profile who took this course completed it",
        "Addresses your 'decorators' skill gap from the last assessment"
      ],
      "fit_level": "strong"
    }
  ],
  "ai_status": "available",
  "generated_at": "2026-06-30T14:22:00Z"
}
```

---

## D1 Schema

```sql
-- Stores enrollment patterns for collaborative filtering
CREATE TABLE IF NOT EXISTS learner_profile_vectors (
  org_id TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  skill_level TEXT NOT NULL,           -- 'beginner', 'intermediate', 'advanced'
  completed_course_ids TEXT NOT NULL,  -- JSON array: ["course-1", "course-2"]
  next_enrollments TEXT NOT NULL,      -- JSON object: {"course-x": 1, "course-y": 2} (course_id → enrollment order)
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, learner_id)
);

-- Tracks recommendation impressions and clicks for feedback loop
CREATE TABLE IF NOT EXISTS recommendation_events (
  org_id TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  event_type TEXT NOT NULL,            -- 'impression', 'click', 'enroll'
  recommendation_batch_id TEXT NOT NULL, -- groups recs shown together
  score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rec_events_learner ON recommendation_events(org_id, learner_id);
CREATE INDEX idx_rec_events_batch ON recommendation_events(recommendation_batch_id);
```

---

## Fallback Cascade (in priority order)

| Tier | Condition | What happens |
|------|-----------|-------------|
| **0** | KV cache hit | Return cached recs instantly (24h TTL) |
| **1** | All 4 signals available | Full hybrid scoring (best result) |
| **2** | AI03 unreachable | Skip AI signal → weight redistribution to 40/30/30 |
| **3** | Vectorize courses index empty (no indexed courses) | Skip content signal → weight to 35/35/30 |
| **4** | D1 has no learner history (cold start) | Skip collaborative → weight to 50/0/50 (content + skill gaps) |
| **5** | LMS skill gaps unavailable | Skip skill gap signal → weight to 50/50/0 (gaps inferred from profile) |
| **6** | Cold start + all offline | Return popular + catalog-based suggestions, `ai_status: "degraded"` |
| **7** | LMS catalog unavailable | Return `{ recommendations: [], ai_status: "unavailable" }` |

---

## Prompt Engineering for AI Scoring (Signal 4)

```
System:
You are a curriculum advisor for a learning platform. Your job is to rank candidate
courses by how well they fit a specific learner. Consider: their skill level, learning
history, career goals, engagement patterns, and skill gaps. Be honest — if a course
is clearly too advanced or too basic, score it low and explain why.

User:
Learner profile:
- Skills: {skills}
- Completed courses: {completed_courses}
- Current courses: {in_progress}
- Career goals: {goals}
- Engagement: {login_streak}-day streak, {level} level, {completion_rate}% completion rate
- Skill gaps: {skill_gaps}

Candidate courses:
{courses_json}

For each course, provide:
1. score (0-100): how well it fits this specific learner
2. reason (one sentence): why it fits (or doesn't)
3. fit_level: "strong" (>80), "moderate" (50-80), or "weak" (<50)

Return JSON array only. No markdown, no explanation outside the JSON.

Response format:
[{"course_id": "...", "score": 85, "reason": "...", "fit_level": "strong"}]
```

---

## KV Cache Strategy

| Key pattern | TTL | Invalidation trigger |
|-------------|-----|---------------------|
| `recs:{org_id}:{learner_id}` | 24h | Learner completes a course, enrolls, or profile updates |
| `recs:similar:{org_id}:{course_id}` | 6h | Course metadata changes, new courses published |
| `recs:next:{org_id}:{learner_id}:{course_id}` | 24h | Learner completes a course, enrollment data shifts |
| `recs:popular:{org_id}` | 6h | New course published, enrollment patterns shift |

Cache invalidation happens via a simple Worker endpoint: `POST /recommendations/invalidate?learner_id={id}&org_id={id}` — called by AI07 Enhanced Recs Worker when it detects stale data.

---

## The "Similar Courses" Endpoint

`GET /recommendations/similar?course_id={id}&org_id={id}&limit={n}`

This is a browsing-context variant — the learner is exploring, not committing. The engine biases toward content similarity and de-emphasizes progression:

1. Embed the given course's description → query Vectorize for courses with high cosine similarity (Signal 1, dominant at 50%)
2. Query D1 for "learners who took this course also took..." (Signal 2, 30%)
3. Skip skill-gap signal entirely (learner is browsing, not filling a known gap)
4. AI03 ranks candidates by topic fit rather than personal fit (Signal 4, 20%)

Use case: shown on the course detail page — "If you like Python Basics, you might also like..."

---

## The "Next Course" Endpoint

`GET /recommendations/next?learner_id={id}&org_id={id}&course_id={id}`

This is a progression-context variant — the learner just finished a course and needs the logical next step. Difficulty is biased one level harder:

1. Looks up what learners typically enroll in after `course_id` (collaborative signal from D1, dominant at 35%)
2. Finds courses that list `course_id` as a prerequisite — these get a scoring boost
3. Finds courses that build on `course_id`'s skills (content signal from Vectorize, 30%)
4. Checks learner's skill gaps for courses that fill them (Signal 3, 20%)
5. AI03 ranks by personal fit given the learner's current course (Signal 4, 15%)

Use case: shown on the "Course Complete" page — "Now that you know Python, try Data Structures."

---

## /next endpoint — Prompt

```
System:
You are recommending the NEXT course for a learner who just completed {current_course_title}.
Consider prerequisites, skill progression, and the learner's goals.

User:
Just completed: {current_course_title} ({current_course_difficulty}, {current_course_skills})
Learner goals: {goals}
Candidate next courses: {courses_json}

Return JSON array of ranked next courses (same format as recommendations).
```

---

## Integration with AI07 Enhanced Recs

AI07 always tries LMS recommendations first. If LMS recs are available:

```
AI07 flow:
  LMS recs → enhance with AI "why this fits" → return

AI07 fallback (LMS recs missing):
  → call AI07b Worker → AI07b returns full scored recommendations
  → AI07 wraps them with the same response shape → return
```

AI07b is called as a Service Binding: `await env.REC_ENGINE.fetch(...)`.

If AI07b is not deployed (LMS recs are working fine), AI07 skips it entirely.

---

## Acceptance Criteria

- [ ] Three endpoints: `/recommendations`, `/recommendations/similar`, `/recommendations/next`
- [ ] Each endpoint uses a different signal weighting appropriate to its UX context
- [ ] Returns personalized recommendations using at least 2 of 4 signals (content, collaborative, skill-gap, AI)
- [ ] `/similar` correctly biases toward content similarity (skips skill-gap signal)
- [ ] `/next` correctly biases toward progression (prerequisite boost, difficulty+1)
- [ ] Scoring includes clear reasons (not just "you might like this")
- [ ] KV cache: second call returns <50ms (cache hit) for all three endpoints
- [ ] Cold start learner (no history) still gets recommendations (popular + catalog-based)
- [ ] Fallback cascade works: degrade gracefully as signals become unavailable
- [ ] Unit tests: signal computation, score blending, cache hit/miss, cold start
- [ ] Integration test: full flow with real LMS data
- [ ] **Observability:** Each signal computation is a separate span in trace
- [ ] **Observability:** Final score breakdown visible in returned response
- [ ] **Observability:** Degraded responses marked with `ai_status` and missing signals listed

---

## Effort Estimate

| Component | Lines | Effort |
|-----------|-------|--------|
| D1 schema + migrations | ~30 | Low |
| Content-based signal (Vectorize query) | ~40 | Low |
| Collaborative signal (D1 query) | ~50 | Medium |
| Skill-gap signal (LMS fetch + filter) | ~40 | Low |
| AI scoring signal (AI03 call + prompt) | ~60 | Medium |
| Score blending + per-endpoint weighting | ~40 | Low |
| KV cache logic | ~30 | Low |
| Fallback cascade | ~40 | Medium |
| `/recommendations` (dashboard) | ~20 | Low |
| `/similar` endpoint (course page) | ~30 | Low |
| `/next` endpoint (completion) | ~30 | Low |
| Tests (unit + integration) | ~100 | Medium |
| **Total** | **~510** | **~3 days** |

---

## Build Order

1. D1 schema + D1 helper utilities
2. Content-based signal (Vectorize — query courses index)
3. Collaborative signal (D1 queries + enrollment pattern storage)
4. Skill-gap signal (LMS API fetch + catalog filter)
5. AI scoring signal (AI03 prompt)
6. Score blending + ranking with configurable weights (per-endpoint weighting)
7. KV cache layer (all 4 key patterns)
8. Fallback cascade
9. `/recommendations` endpoint (dashboard — all signals)
10. `/recommendations/similar` endpoint (course page — content-biased)
11. `/recommendations/next` endpoint (completion — progression-biased)
12. Observability spans
13. Tests
14. Integration with AI07 Enhanced Recs Worker

---

## Decision: When to Build This

| Trigger | Action |
|---------|--------|
| LMS `GET /api/v1/courses/recommendations` returns 200 with real, personalized recs | **Skip this issue.** AI07 enhances LMS recs. |
| LMS endpoint returns 200 but with generic/hardcoded recs | **Build this issue.** AI07 uses it as fallback, AI07b provides signal quality. |
| LMS endpoint returns 404 or 500 | **Build this issue.** It becomes the primary recommendation engine. |
| LMS endpoint returns 200 with positional/category-only recs (limited to 1 signal) | **Build this issue.** AI07b supplements with 3 additional signals. |

---

## What This Does NOT Replace

- **AI07 Enhanced Recs** — still needed for the `ai_why_this_fits` explanations layer
- **AI06 Learning Paths** — different problem (sequenced curriculum vs. single-course suggestions)
- **LMS catalog** — we read it, don't duplicate it
- **LMS skill gaps** — we consume them, don't compute them
- **LMS frontend rendering** — the LMS decides where and how to display each recommendation widget

AI07b is a **recommendation engine** embedded in multiple LMS pages. AI07 is a **recommendation enhancer**. They serve different purposes but compose together.
