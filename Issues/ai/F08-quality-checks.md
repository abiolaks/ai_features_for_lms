# F08: Quality Checks (AI11)

- **Type:** AFK
- **Phase:** 2
- **Depends on:** F07 (Question Generation), AI03 (LLM Gateway)

## What to build

Validates AI-generated questions for accuracy, bias, clarity, and difficulty alignment before they're approved for quizzes. Catches hallucinated answers, misleading distractors, and poorly-worded questions.

**Endpoint:**

`POST /questions/validate`
→ request: `{ questions: [{ text, options, correct_answer, difficulty, topic, source_content }] }`
→ response: `{ results: [{ question_index, passed, issues: [], suggestions: [] }] }`

**Checks performed:**
1. **Accuracy** — Is the correct answer actually verifiable from source_content? The check LLM reads the source and the question, then flags hallucinations.
2. **Distractor quality** — Are wrong answers genuinely wrong (not ambiguous) when read against the source?
3. **Clarity** — Is the question wording unambiguous? Would a learner understand what's being asked?
4. **Difficulty alignment** — Does the assigned difficulty match the content complexity?
5. **Bias check** — Are there any demographic assumptions or cultural references that could disadvantage learners?

**Behavior:**
1. For each question, build a validation prompt:
   ```
   You are a quiz quality reviewer. Evaluate this question against the source:
   
   Source content: {source}
   Question: {text}
   Correct answer: {correct}
   Difficulty: {difficulty}
   
   Check: (1) answer accuracy, (2) distractor quality, (3) clarity,
   (4) difficulty alignment, (5) bias. Return JSON with passed (bool),
   issues (string[]), suggestions (string[]).
   ```
2. Call AI03 Gateway (standard tier is sufficient for validation)
3. Aggregate results per question
4. Return pass/fail with actionable suggestions

## Acceptance criteria

- [ ] Validates each question against source content for accuracy
- [ ] Flags hallucinated answers, ambiguous distractors, unclear wording
- [ ] Checks difficulty alignment (beginner question shouldn't require advanced knowledge)
- [ ] Bias check catches demographic assumptions
- [ ] Returns actionable suggestions for failed questions
- [ ] Unit tests: accuracy check, distractor check, difficulty, bias
- [ ] Observability: questions validated, pass rate, issue categories
