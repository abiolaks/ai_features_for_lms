# Slice 10a: Question Generation Engine

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 2, Slice 3
- **Blocked by (external):** None (lesson content and course difficulty from mock platform)
- **User stories covered:** 26–31 (generation + source tracing; approval workflow split to 10b)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 10: Assessment Generation (split — question generation concern)

## What to build

Generates quiz questions from a source lesson using RAG retrieval and the quality-tier LLM. Each generated question traces back to a specific source excerpt.

Endpoint: `POST /assessments/generate` — body:

```json
{
  "lesson_id": "...",
  "course_id": "...",
  "org_id": "...",
  "num_questions": 5,
  "question_types": ["multiple_choice", "true_false", "short_answer"]
}
```

**Generation flow:**

1. Fetch lesson content metadata from Slice 0
2. Retrieve relevant chunks via Slice 2 (course scope, to capture full context)
3. Build a prompt for Slice 3 (tier=**quality**) that generates questions grounded in the retrieved chunks
4. Each question includes:
   - `question_text` — the question
   - `question_type` — multiple_choice / true_false / short_answer
   - `options` — for multiple_choice, list of 4 options with correct indicator
   - `correct_answer` — for short_answer / true_false
   - `source` — `{chunk_id, excerpt, lesson_title, section_heading, timestamp?}`
   - `status` — always `pending` on generation (approval is Slice 10b)

Returns: `{questions: [...], lesson_id, course_id, generated_at}`

**No approval logic** in this slice. Generated questions are returned as-is. Approval workflow is Slice 10b.

## Acceptance criteria

- [ ] POST /assessments/generate with num_questions=5 → returns 5 questions (±10%, LLM non-determinism)
- [ ] Each question has question_text, question_type, correct_answer, and source excerpt
- [ ] Multiple choice questions have exactly 4 options with one marked correct
- [ ] True/false questions have boolean correct_answer
- [ ] Short answer questions have expected answer text
- [ ] Each question's source traces to a specific chunk with lesson_title, section_heading, excerpt
- [ ] Every generated question has `status: "pending"`
- [ ] num_questions=0 → returns 422 with validation error
- [ ] num_questions > 20 → returns 422 (sane upper bound)
- [ ] Lesson not found → returns 404
- [ ] Uses Slice 3 with tier=quality (assessment generation needs capable model)
- [ ] Unit tests: prompt construction, source trace attachment, question count validation
- [ ] Unit tests: response parsing (LLM may return slightly different formats — parser must be robust)
- [ ] Integration tests: generate from Slice 1b indexed content → verify questions are grounded in source chunks

## Blocked by

- Slice 0 (mock platform for lesson metadata)
- Slice 2 (RAG Retrieval Engine)
- Slice 3 (LLM Gateway, quality tier)
