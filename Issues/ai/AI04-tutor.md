# AI04: Tutor — Grounded Q&A

- **Type:** AFK
- **Week:** 3
- **Blocked by:** AI02 (RAG), AI03 (LLM Gateway), LMS `GET /api/v1/lessons/{id}`
- **PR target:** ~300 lines

## What to build

Grounded Q&A engine. Learner asks a question about lesson content → AI answers with citations to specific sections.

**One endpoint:**

`POST /tutor/ask` — body: `{ question, lesson_id, course_id, org_id }`
→ response: `{ answer, citations: [{ lesson_title, section_heading, excerpt }], scope_expansion_suggested? }`

**Behavior:**
1. Fetch lesson structure from LMS: `GET /api/v1/lessons/{lesson_id}` → title + sections (for building citations)
2. Retrieve relevant chunks via AI02 Service Binding → `POST /retrieve` with `scope: { type: "lesson", id: lesson_id }`
3. Build grounded prompt:
   ```
   Answer the question using ONLY the provided content below.
   If the answer is not in the content, say "I couldn't find that in this lesson."
   Cite the section heading for each fact.

   CONTENT:
   [Section: Defining Functions] To define a function in Python...
   [Section: Arguments] Functions can accept parameters...

   QUESTION: What is a decorator?
   ```
4. Call AI03 Service Binding → `POST /generate` (tier=standard)
5. Parse response → extract citations → return to caller

**Scope expansion:**
- When answer = "not found" → set `scope_expansion_suggested: true`
- Frontend can retry with `expand_scope: "module"` → AI02 query widens to module scope
- If module also fails → offer `expand_scope: "course"`

**No conversation history in this slice** — stateless Q&A. History is post-MVP.

## Acceptance criteria

- [ ] Ask question about lesson content → cited answer with section heading + excerpt
- [ ] Ask question not in lesson → `"I couldn't find that"` + `scope_expansion_suggested: true`
- [ ] Expand scope to module → wider retrieval, answer returned
- [ ] Answer is grounded — prompt enforces "use ONLY provided content"
- [ ] If AI02 returns no chunks → responds "not found" without calling AI03
- [ ] Integration: index lesson via AI01 → query via AI02 → ask via AI04 → get cited answer
- [ ] Unit tests: prompt construction, citation parsing, scope expansion logic, groundedness check
- [ ] **Observability:** Full trace shows: fetch LMS → Vectorize query → fetch Huawei → response
- [ ] **Observability:** LLM span includes prompt, response, model, tokens, latency
- [ ] **Observability:** `scope_expansion` flag captured, citations count (`citations.count: N`)
