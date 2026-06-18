# Platform Slice P08: Quiz Engine

- **Type:** AFK
- **Blocked by:** P03 (lessons must exist), P05 (learner auth)
- **User stories covered:** Platform — create quizzes, take quizzes, get scores

## What to build

The quiz engine. Course authors create quizzes manually (AI-generated quizzes come later in AI10a). Learners take quizzes and get scored. Every per-question result is stored for AI08 (Post-Activity Insights).

### Service: `services/quizzes/`

FastAPI app on port `8014`.

### Endpoints

**Quiz management (author-side, no auth for MVP — admin only):**
```
POST   /quizzes                         Create quiz with questions
GET    /quizzes/{quiz_id}               Get quiz (without correct answers)
GET    /quizzes/{quiz_id}/admin         Get quiz (with correct answers — for authoring)
PUT    /quizzes/{quiz_id}               Update quiz questions
DELETE /quizzes/{quiz_id}               Delete quiz
GET    /lessons/{lesson_id}/quizzes     List quizzes for a lesson
```

**Quiz taking (learner-side, auth required):**
```
POST   /quizzes/{quiz_id}/start         Start attempt → returns questions without answers
POST   /quizzes/{quiz_id}/submit        Submit answers → returns score + per-question results
GET    /attempts/{attempt_id}           Get attempt results (score + details)
GET    /learners/{id}/attempts          List all quiz attempts for a learner
```

### Creating a quiz

`POST /quizzes` — body:
```json
{
  "lesson_id": "...",
  "title": "Python Basics Quiz",
  "questions": [
    {
      "question_text": "What does print() do?",
      "question_type": "multiple_choice",
      "options": [
        {"text": "Displays output", "is_correct": true},
        {"text": "Reads input", "is_correct": false},
        {"text": "Saves to file", "is_correct": false},
        {"text": "Deletes data", "is_correct": false}
      ],
      "sort_order": 1
    },
    {
      "question_text": "Python is case-sensitive.",
      "question_type": "true_false",
      "correct_answer": "true",
      "sort_order": 2
    }
  ]
}
```

Questions are created with `status: "approved"` by default (manually authored questions skip the approval workflow).

### Taking a quiz

`POST /quizzes/{quiz_id}/start` → returns the quiz with correct answers stripped:
```json
{
  "data": {
    "attempt_id": "...",
    "quiz_id": "...",
    "title": "Python Basics Quiz",
    "questions": [
      {
        "question_id": "...",
        "question_text": "What does print() do?",
        "question_type": "multiple_choice",
        "options": [
          {"text": "Displays output"},
          {"text": "Reads input"},
          {"text": "Saves to file"},
          {"text": "Deletes data"}
        ]
      }
    ]
  }
}
```

`POST /quizzes/{quiz_id}/submit` — body:
```json
{
  "attempt_id": "...",
  "answers": [
    {"question_id": "...", "answer": "Displays output"}
  ]
}
```

Returns:
```json
{
  "data": {
    "attempt_id": "...",
    "score_pct": 85.0,
    "total_questions": 10,
    "correct_count": 8,
    "results": [
      {
        "question_id": "...",
        "question_text": "What does print() do?",
        "was_correct": true,
        "correct_answer": "Displays output",
        "learner_answer": "Displays output"
      }
    ]
  }
}
```

### Post-submit

On submit, the engine:
1. Stores `quiz_attempts` row (score, counts)
2. Stores `quiz_attempt_details` rows (per-question correctness)
3. Returns the full results to the caller
4. AI08 (Post-Activity Insights) can then fetch this data to generate coaching messages

## Acceptance criteria

- [ ] POST /quizzes → create quiz with 5 questions of mixed types, returns 201
- [ ] GET /quizzes/{id} → returns quiz without correct answers (for displaying to learner)
- [ ] GET /quizzes/{id}/admin → returns quiz with correct answers (for authoring)
- [ ] POST /quizzes/{id}/start → returns attempt with stripped answers
- [ ] POST /quizzes/{id}/submit → scores correctly, returns per-question results
- [ ] All answers correct → score_pct = 100.0
- [ ] Half correct → score_pct = 50.0
- [ ] Multiple choice: answer matched by text, case-insensitive
- [ ] True/false: answer matched as string "true"/"false"
- [ ] Short answer: exact match (case-insensitive)
- [ ] GET /attempts/{id} → retrieves stored attempt with all details
- [ ] GET /learners/{id}/attempts → lists all attempts sorted by date
- [ ] Auth required on /start, /submit, /attempts (learner endpoints)
- [ ] Unit tests: scoring logic for each question type, edge cases (empty answers, extra answers)
- [ ] Integration tests: create quiz → start → submit → verify score → verify stored details

## Blocked by

- P03 — needs lessons to attach quizzes to
- P05 — needs learner auth for taking quizzes

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
