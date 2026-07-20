# F07: Question Generation (AI10a)

- **Type:** AFK
- **Phase:** 2
- **Depends on:** AI03 (LLM Gateway), LMS `/api/v1/lessons/{id}`, quality tier LLM (mistral-7b)

## What to build

Auto-generate quiz questions from lesson content. The AI reads an indexed lesson and produces multiple-choice questions with answers, distractors, and difficulty ratings.

**Endpoint:**

`POST /questions/generate`
→ request: `{ lesson_id, org_id, count?: 5, type?: "multiple-choice" | "true-false" }`
→ response: `{ questions: [{ text, options, correct_answer, difficulty, topic }] }`

**Behavior:**
1. Fetch lesson content from LMS (`/api/v1/lessons/{id}`)
2. If video: retrieve transcript chunks from Vectorize
3. If text/PDF: use entity.content directly
4. Build generation prompt with quality tier:
   ```
   Generate {count} {type} questions from this lesson content.
   Each question must be answerable from the content alone.
   Include: question text, 4 options (1 correct + 3 plausible distractors),
   difficulty (beginner/intermediate/advanced), and topic tag.
   Return JSON array only.
   ```
5. Call AI03 Gateway → Worker AI (mistral-7b for quality tier)
6. Parse + validate response format
7. Return questions

## Acceptance criteria

- [ ] Generates 5 multi-choice questions from a single lesson
- [ ] All answers are verifiable from the source content
- [ ] Distractors are plausible but clearly wrong with source context
- [ ] Each question tagged with topic + difficulty
- [ ] Uses quality tier LLM (mistral-7b) via AI03
- [ ] Handles video transcripts, PDFs, and text lessons
- [ ] Degrades gracefully when content is insufficient
- [ ] Unit tests: prompt construction, response parsing, validation
- [ ] Observability: content token count, questions generated, tier used
