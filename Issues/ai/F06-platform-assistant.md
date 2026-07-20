# F06: Platform Assistant (AI09)

- **Type:** AFK
- **Phase:** 2
- **Depends on:** AI03 (LLM Gateway), LMS `/api/v1/catalog`, `/api/v1/lessons`, `/api/v1/learner/profile`

## What to build

A chat-based assistant that answers platform-wide questions across all courses. Unlike the Tutor (scoped to a single lesson), the Assistant can answer questions like "What courses cover machine learning?", "What should I learn before taking Data Science?", or "Show me beginner-friendly Python courses."

**Endpoint:**

`POST /assistant/ask`
→ request: `{ question, learner_id, org_id }`
→ response: `{ answer, citations, suggested_courses }`

**Behavior:**
1. Embed question → query Vectorize across all indexed lessons (course scope)
2. Fetch catalogue + learner profile from LMS
3. Build prompt combining retrieved content + catalogue metadata
4. Call AI03 Gateway for answer
5. Return answer with citations and suggested course links

**Key differentiators from Tutor:**
- Course-level scope (not lesson-scoped)
- Returns course recommendations inline with answer
- Multi-turn conversation state (Durable Object per learner)
- Sync history between Assistant and Tutor sessions

## Acceptance criteria

- [ ] Answers platform-wide questions with citations from indexed content
- [ ] Suggests relevant courses from the catalogue
- [ ] Multi-turn conversation persists in Durable Object
- [ ] Degrades gracefully when Vectorize is empty or AI03 is down
- [ ] Unit tests: RAG retrieval, course suggestion logic, multi-turn state
- [ ] Observability: spans for retrieval, gateway call, course suggestion
