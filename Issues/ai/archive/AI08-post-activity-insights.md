# Slice 8: Post-Activity Insights

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 3
- **Blocked by (external):** None (quiz result data POSTed to the service; UI is platform team scope)
- **User stories covered:** 19–22

## Parent

`docs/vertical-slices-phase-1.md` — Slice 8: Post-Activity Insights

## What to build

Generates a coaching insight after each quiz completion. Single-quiz context only — no cross-quiz pattern analysis.

Endpoint: `POST /insights/generate` — body:

```json
{
  "learner_id": "...",
  "org_id": "...",
  "quiz": {
    "lesson_id": "...",
    "course_id": "...",
    "score_pct": 85,
    "total_questions": 10,
    "correct_questions": 8,
    "incorrect_questions": [
      {"question_id": "q3", "topic": "Python decorators", "lesson_section": "Advanced Functions"}
    ]
  }
}
```

**Two response modes:**

| Score | Response type | Content |
|-------|--------------|---------|
| ≥80% | Positive reinforcement | Highlights mastered topics, encouraging tone. "Great work! You've shown strong understanding of..." |
| <80% | Supportive coaching | Acknowledges effort, identifies missed topics, includes direct review links to specific lesson sections. No shaming language. |

Both modes use Slice 3 (tier=standard) for generation. The prompt enforces: "Be encouraging and supportive. Never use negative, shaming, or discouraging language regardless of score."

Review links are constructed from the mock platform's lesson structure (`GET /course/{course_id}/lessons`). Each missed topic maps to a section link: `/courses/{course_id}/lessons/{lesson_id}#{section_slug}`.

## Acceptance criteria

- [ ] Quiz score ≥80% → returns positive reinforcement message highlighting mastered topics
- [ ] Quiz score <80% → returns coaching message with review links for missed topics
- [ ] Each review link points to the specific lesson section for the missed topic
- [ ] Insight references only the current quiz (no "you've been improving lately" cross-quiz language)
- [ ] Tone is encouraging for both high and low scores (validate no negative language in output)
- [ ] Prompt explicitly forbids shaming, negative, or discouraging language
- [ ] All incorrect questions mentioned → review link for each
- [ ] Quiz with 100% score → still returns positive message (not blank or error)
- [ ] Quiz with 0% score → still returns supportive message (not blank or error)
- [ ] Invalid score (>100 or <0) → returns 422
- [ ] Unit tests: score threshold (80% boundary), tone validation (regex/LLM-as-judge), link generation
- [ ] Unit tests: edge cases (100%, 0%, exactly 80%)
- [ ] Integration tests: POST sample quiz → receive insight → verify tone and links match mock lesson structure

## Blocked by

- Slice 0 (mock platform for lesson structure + sample quiz payloads)
- Slice 3 (LLM Gateway)
