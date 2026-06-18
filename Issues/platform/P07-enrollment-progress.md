# Platform Slice P07: Enrollment & Progress

- **Type:** AFK
- **Blocked by:** P05 (learner auth), P03 (courses must exist)
- **User stories covered:** Platform — learner enrolls, tracks progress, sees what's next

## What to build

Enrollment management and lesson-by-lesson progress tracking. This is the "My Learning" backbone that AI features (Tutor, Assistant, Recommendations) query for learner context.

### Service: `services/progress/`

FastAPI app on port `8013`. All endpoints require auth.

### Endpoints

**Enrollment:**
```
POST   /enroll/{course_id}          Enroll in a course
GET    /enrollments                  List learner's enrolled courses
DELETE /enroll/{course_id}           Unenroll (keeps progress data for audit)
```

**Progress:**
```
POST   /progress/{lesson_id}/complete    Mark lesson as completed
POST   /progress/{lesson_id}/uncomplete  Unmark lesson (for retakes)
GET    /progress/{course_id}             Progress summary for a course
GET    /progress/next                    "What should I do next?" across all courses
```

### Enrollment (`POST /enroll/{course_id}`)

- Authenticated learner enrolls in a course
- Returns 201 on first enrollment, 200 if already enrolled (idempotent)
- Creates `enrollments` row

### My enrollments (`GET /enrollments`)

Returns list of enrolled courses with progress summary:
```json
{
  "data": [
    {
      "course_id": "...",
      "course_title": "Introduction to CS",
      "enrolled_at": "2026-01-15T...",
      "completed_lessons": 12,
      "total_lessons": 48,
      "progress_pct": 25.0,
      "next_lesson": {
        "lesson_id": "...",
        "title": "Functions and Scope",
        "module_title": "Python Basics"
      }
    }
  ]
}
```

### Progress summary (`GET /progress/{course_id}`)

Detailed progress for one course:
```json
{
  "data": {
    "course_id": "...",
    "progress_pct": 25.0,
    "completed_lessons": 12,
    "total_lessons": 48,
    "modules": [
      {
        "module_id": "...",
        "title": "Python Basics",
        "completed_lessons": 5,
        "total_lessons": 5,
        "complete": true
      },
      {
        "module_id": "...",
        "title": "Functions",
        "completed_lessons": 2,
        "total_lessons": 7,
        "complete": false
      }
    ]
  }
}
```

### What's next (`GET /progress/next`)

Returns the single next lesson across all enrolled courses, prioritizing:
1. Courses with the least progress (help learner finish what they started)
2. First incomplete lesson in the earliest incomplete module

```json
{
  "data": {
    "course_id": "...",
    "course_title": "...",
    "lesson_id": "...",
    "lesson_title": "Functions and Scope",
    "module_title": "Python Basics",
    "progress_pct": 25.0
  }
}
```

### Course completion

When all lessons in a course are completed, the enrollment's `completed_at` is set automatically. A completed course stays in the enrollment list but sorted to the bottom.

## Acceptance criteria

- [ ] POST /enroll/{course_id} → learner enrolled, returns 201
- [ ] POST /enroll/{course_id} again → returns 200 (already enrolled)
- [ ] POST /enroll with invalid course → returns 404
- [ ] GET /enrollments → lists enrolled courses with progress percentages
- [ ] GET /enrollments for new learner → empty list, not error
- [ ] POST /progress/{lesson_id}/complete → marks lesson done, progress updates
- [ ] Completing last lesson in a course → enrollment.completed_at is set
- [ ] GET /progress/{course_id} → per-module breakdown with completion flags
- [ ] GET /progress/next → returns the next lesson to take
- [ ] GET /progress/next when all courses complete → returns null next_lesson
- [ ] DELETE /enroll/{course_id} → unenrolls, progress data retained
- [ ] Cross-learner isolation: learner A's progress not visible to learner B
- [ ] Auth required on all endpoints (401 without X-API-Key)
- [ ] Unit tests: progress calculation, next-lesson logic, completion detection
- [ ] Integration tests: register → enroll → complete lessons → verify progress → unenroll

## Blocked by

- P05 — needs learner auth middleware
- P03 — needs courses to enroll in

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
