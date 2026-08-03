# F03b: Session Prep Insights

- **Type:** AFK
- **Phase:** 2
- **Depends on:** AI03 (LLM Gateway), LMS `/api/v1/learner/profile`, `/api/v1/progress/user`, `/api/v1/learner/assessments`

## What to build

Given a learner's recent activity, generate a structured session agenda for mentors. Helps mentors walk into sessions prepared with talking points, focus areas, and links to relevant materials.

**Endpoint:**

`POST /mentor/session-prep`
→ request: `{ learner_id, mentor_id, org_id }`
→ response: `{ recent_activity, suggested_agenda, prep_materials }`

**Behavior:**
1. Fetch learner profile, progress, and recent quiz results from LMS
2. Identify: lowest quiz topics, stalled modules, completed lessons
3. Build prompt:
   ```
   The learner has: {progress_summary}, {quiz_summary}, {stalled_modules}.
   Generate a 3-topic session agenda prioritized by urgency.
   Include topic name, reason, and suggested duration in minutes.
   Return JSON: [{ topic, reason, duration_min }]
   ```
4. Call AI03 Gateway (standard tier)
5. Return agenda with prep material links

## Response shape

```json
{
  "recent_activity": {
    "completed_lessons": 12,
    "quiz_scores": { "avg": 72, "lowest_topic": "recursion" },
    "stalled_modules": ["advanced-algorithms"]
  },
  "suggested_agenda": [
    { "topic": "Recursion review", "reason": "Lowest quiz score (45%)", "duration_min": 15 },
    { "topic": "Algorithm complexity", "reason": "Blocks progress in Advanced Algorithms", "duration_min": 20 },
    { "topic": "Next steps", "reason": "Discuss Data Engineering track", "duration_min": 10 }
  ],
  "prep_materials": [
    { "lesson_title": "Recursion Basics", "link": "/courses/cs101/lessons/recursion" }
  ]
}
```

## Acceptance criteria

- [ ] Returns recent activity summary from LMS data
- [ ] Suggested agenda prioritized by urgency (low scores first)
- [ ] Each agenda item includes reason + suggested duration
- [ ] Prep materials link to specific lessons in the LMS
- [ ] No learner activity → returns skeleton agenda (review profile, set goals)
- [ ] Degrades gracefully when LMS data is unavailable
- [ ] Unit tests: agenda prioritization, empty-state handling, prompt construction
- [ ] Observability: span for data fetch, gateway call, agenda generation
