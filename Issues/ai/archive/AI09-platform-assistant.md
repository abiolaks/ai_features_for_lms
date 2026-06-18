# Slice 9: Platform Assistant

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 3, Slice 4a
- **Blocked by (external):** None (learner progress fetched from mock; UI widget is platform team scope)
- **User stories covered:** 23–25

## Parent

`docs/vertical-slices-phase-1.md` — Slice 9: Platform Assistant

## What to build

A persistent assistant for navigation and progress questions — not tutoring. Routes intents between progress queries and content questions.

Endpoint: `POST /assistant/ask` — body: `{question, learner_id, org_id, current_lesson_id?}`

**Intent routing (rule-based, no LLM needed):**

1. Classify the question as `progress` or `content` intent (keyword + pattern matching)
2. Route accordingly:

| Intent | Behavior |
|--------|----------|
| **progress** | Fetches enrollment data from mock platform (`GET /learner/{id}/progress`). Returns progress percentage, next lesson, course completion status. Example: *"You're 65% through Python Fundamentals. Next up: 'Error Handling' — about 20 minutes."* |
| **content** (in a lesson) | Does NOT answer the question. Returns handoff: *"For questions about this lesson's content, try the Lesson Tutor."* Includes a link to the Tutor: `/courses/{course_id}/lessons/{lesson_id}?tutor=open` |
| **content** (not in a lesson) | Returns: *"I can't answer content questions here. Navigate to the lesson and use the Tutor — it can search across the lesson and module."* |

**Conversation history** is separate from the Tutor. Stored in the same pattern as Slice 4b but namespaced under `assistant:` prefix. Exposes the same CRUD endpoints (`/assistant/history`, `/assistant/history/{learner_id}`).

## Acceptance criteria

- [ ] "How far am I in this course?" → returns progress percentage and next lesson name
- [ ] "What should I do next?" → returns next incomplete lesson or course suggestion
- [ ] "How many lessons left?" → returns remaining count and estimated time
- [ ] Content question while `current_lesson_id` is set → handoff message with Tutor deep link
- [ ] Content question without `current_lesson_id` → suggests navigating to a lesson and using Tutor
- [ ] Assistant history is stored separately from Tutor history (different namespace)
- [ ] Assistant history CRUD works identically to Tutor history (30-day retention, full delete)
- [ ] Intent routing covers ≥90% of expected question patterns (tested with known query set)
- [ ] Unknown intent → returns helpful fallback: "I can help with your course progress. Try asking 'How far am I?'"
- [ ] Unit tests: intent classification accuracy, progress response formatting, handoff message generation
- [ ] Unit tests: history namespace isolation from Tutor
- [ ] Integration tests: ask progress question → verify accurate data from mock platform; ask content question in lesson → verify handoff link

## Blocked by

- Slice 0 (mock platform for learner progress data)
- Slice 3 (LLM Gateway — used only if future intent routing needs LLM; Phase 1 uses rule-based routing)
- Slice 4a (Tutor Core — for handoff deep link construction)
