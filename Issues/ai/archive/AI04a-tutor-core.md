# AI04a: Tutor Core (covers AI-04 In-Lesson Tutor + AI-05 Study Copilot)

- **Type:** AFK
- **Blocked by (internal):** P10 (Platform Gateway), AI02, AI03
- **Blocked by (external):** None (lesson context passed in request body; chat UI is platform team scope)
- **User stories covered:** 13–18 (core Q&A and scope expansion; conversation history split to 4b)
- **Requirements covered:** AI-04 (In-Lesson Grounded Q&A), AI-05 (Study Copilot — scope selector merges both)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 4: In-Lesson Tutor (split — core Q&A concern)

**Design decision:** The requirements doc lists AI-04 (In-Lesson Tutor) and AI-05 (Study Copilot) as separate features. We merge them into one slice because the scope selector (`lesson → module → course`) serves both use cases — in-lesson help defaults to lesson scope, exam revision expands to module or course scope. No separate service needed.

## What to build

The grounded Q&A engine behind the In-Lesson Tutor. Accepts a learner's question, retrieves relevant chunks from the RAG engine, generates an answer via the LLM Gateway, and attaches citations. Exposes one endpoint:

`POST /tutor/ask` — body: `{question, org_id, lesson_id, module_id, course_id, conversation_id?}`

**Behavior:**

1. Receives question + current lesson context
2. Retrieves relevant chunks via Slice 2 with `lesson` scope
3. Builds a grounded prompt: "Answer using ONLY the provided content. If the answer is not in the content, say so."
4. Calls Slice 3 (tier=standard) to generate the answer
5. Returns `{answer, citations: [{lesson_title, section_heading, timestamp, excerpt}]}`

**When content doesn't contain the answer:**
- Returns: `{answer: "I couldn't find that in this lesson. Would you like me to search across the full module?", citations: [], scope_expansion_suggested: true}`
- A follow-up call with `expand_scope: true` widens the retrieval to `module` scope
- If `module` scope also fails → offers `course` scope expansion

**No conversation history in this slice** — that's Slice 4b. The `conversation_id` parameter is accepted and passed through to 4b but not acted upon here.

## Acceptance criteria

- [ ] Ask question about lesson content → answer returned with inline citations (section, timestamp, excerpt)
- [ ] Ask question about content NOT in the lesson → "not found" response with `scope_expansion_suggested: true`
- [ ] Follow-up with `expand_scope: true` → wider module-scope retrieval used, answer returned
- [ ] Answer is grounded in retrieved chunks (prompt enforces "answer ONLY using provided content")
- [ ] No relevant chunks found at any scope → returns empty answer with "not found" message
- [ ] Each citation includes: lesson_title, section_heading, timestamp (when applicable), excerpt
- [ ] Calls Slice 3 with `tier=standard`
- [ ] Unit tests: answer generation with citations, "not found" response, scope expansion logic
- [ ] Unit tests: groundedness (mock RAG returns irrelevant chunks → tutor says "not found")
- [ ] Integration tests: Slice 0 + 1b + 2 + 3 → ask question → get cited answer

## Blocked by

- Slice 0 (mock platform for lesson metadata)
- Slice 2 (RAG Retrieval Engine)
- Slice 3 (LLM Gateway)
