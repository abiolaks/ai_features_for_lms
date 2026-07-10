GitHub Issue: [#4](https://github.com/datazone-ai/ai_features_for_lms/issues/4)

# AI06: Personalized Learning Paths

- **Type:** AFK
- **Week:** 4
- **Blocked by:** AI03 (LLM Gateway), LMS `/api/v1/catalog`, `/api/v1/learner/profile`, `/api/v1/progress/user`
- **PR target:** ~300 lines

## What to build

Generate an AI-personalized, ordered learning path based on the learner's profile, current progress, and available course catalogue.

**One endpoint:**

`POST /paths/generate` — body: `{ learner_id, org_id }`
→ response: `{ path: [{ course_title, order, why_this_fits }], ai_status }`

**Behavior:**
1. Fetch learner profile: `GET /api/v1/learner/profile`
   → Extract: skills (from `learning_stats`), gamification (points, level, streak), goals (from preferences)
2. Fetch catalogue: `GET /api/v1/catalog` → all published courses with difficulty + category
3. Fetch progress: `GET /api/v1/progress/user` → completed + in-progress enrollments
4. Build prompt:
   ```
   You are a curriculum designer. Given:
   - Learner profile: { skills, goals, experience, streak_days }
   - Available courses: [{ title, difficulty, category }]
   - Completed courses: [{ title }]
   - In-progress courses: [{ title, progress_pct }]

   Generate an ordered learning path of 3-5 courses.
   Exclude completed courses. Place prerequisites before dependents.
   For each course, write one sentence explaining why it fits the learner.
   ```
5. Call AI03 (tier=standard) → parse JSON response
6. Filter out completed courses (safety net — LLM should do this but verify)
7. Validate ordering (no course before its prerequisites)

**Edge cases:**
- Minimal profile (no skills, no goals) → return catalogue browse view with `ai_status: "insufficient_data"`
- LLM unavailable → return catalogue browse view with `ai_status: "degraded"`

## Acceptance criteria

- [ ] Generate path from real profile + catalogue → ordered list with `why_this_fits`
- [ ] Completed courses excluded from path
- [ ] Prerequisites appear before dependents
- [ ] Minimal profile → returns catalogue view with "Add more details" message
- [ ] Each course in path has a one-sentence `why_this_fits` explanation
- [ ] AI03 unavailable → returns course list without explanations, `ai_status: "degraded"`
- [ ] Unit tests: prompt construction, JSON parsing, prerequisite validation
- [ ] **Observability:** Path span includes course count, why_this_fits count, prerequisite violations (0 expected)
- [ ] **Observability:** LMS calls (profile, catalogue, progress) all traced
