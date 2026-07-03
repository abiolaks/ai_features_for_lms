# AI04: Tutor — Grounded Q&A

- **Type:** AFK
- **Week:** 3
- **Blocked by:** AI01 (AI Search must have indexed lessons), AI03 (LLM Gateway), LMS `GET /api/v1/lessons/{id}`
- **PR target:** ~200 lines

## What to build

Grounded Q&A engine. Learner asks a question about video lesson content → AI answers with citations to the lesson.

**One endpoint:**

`POST /tutor/ask` — body: `{ question, lesson_id, course_id, org_id }`
→ response: `{ answer, citations: [{ lesson_title, excerpt, score }], scope_expansion_suggested? }`

**Behavior:**
1. Fetch lesson metadata from LMS: `GET /api/v1/lessons/{lesson_id}` → title, contentType, durationSeconds (for citation labels)
2. Retrieve relevant chunks via AI Search:
   ```typescript
   const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
   const results = await instance.search({
     query: question,
     ai_search_options: {
       retrieval: {
         retrieval_type: "hybrid",
         max_num_results: 5,
         match_threshold: 0.5,
         filters: {
           type: "and",
           filters: [
             { type: "eq", key: "lesson_id", value: lesson_id },
             { type: "eq", key: "org_id", value: org_id },
           ],
         },
       },
       reranking: { enabled: true },
     },
   });
   ```
3. If no chunks above threshold → respond `"I couldn't find that in this lesson"` + `scope_expansion_suggested: true` (don't call AI03)
4. Build grounded prompt:
   ```
   Answer the question using ONLY the provided content below.
   If the answer is not in the content, say "I couldn't find that in this lesson."
   Cite the lesson title for each fact. Be concise.

   CONTENT:
   [Lesson: Python Fundamentals - Intro Video]
   Welcome to Python fundamentals. Today we're going to cover variables,
   data types, and how to write your first function.

   QUESTION: What is a variable?
   ```
5. Call AI03 Service Binding → `POST /generate` (tier=standard)
6. Parse response → extract citations → return to caller

**Scope expansion:**
- When answer = "not found" → set `scope_expansion_suggested: true`
- Frontend can retry with `expand_scope: "module"` → widen filter to `{ type: "eq", key: "module_id", value: module_id }`
- If module also fails → offer `expand_scope: "course"` → filter to `{ type: "eq", key: "course_id", value: course_id }`

**No conversation history in this slice** — stateless Q&A. History is post-MVP.

## AI Search Binding

```toml
# wrangler.toml
[[ai_search_namespaces]]
binding = "AI_SEARCH"
namespace = "lms-platform"
```

## Acceptance criteria

- [ ] Ask question about video lesson content → cited answer with lesson title + excerpt
- [ ] Ask question not in lesson → `"I couldn't find that"` + `scope_expansion_suggested: true`
- [ ] Expand scope to module → wider AI Search filter, answer returned
- [ ] Expand scope to course → even wider, answer returned
- [ ] Answer is grounded — prompt enforces "use ONLY provided content"
- [ ] Works with both transcript-backed and metadata-only fallback lessons
- [ ] Hybrid search used (vector + keyword) — verify by checking `scoring_details.keyword_score` presence
- [ ] If AI Search returns no chunks → responds "not found" without calling AI03
- [ ] Integration test: index video via AI01 → ask via AI04 → get cited answer from transcript
- [ ] Unit tests: prompt construction, citation parsing, scope expansion logic, groundedness check
- [ ] **Observability:** Full trace shows: fetch LMS → AI Search retrieval → AI03 generate → response
- [ ] **Observability:** Retrieval span shows `retrieval_type: hybrid`, `match_threshold`, chunk count
- [ ] **Observability:** `scope_expansion` flag captured, citations count (`citations.count: N`)
- [ ] **Observability:** Reranking enabled, verify `reranking_score` present on chunks

## What Changed From Original Plan

| Before (Path A) | After (Path B + Stream) |
|-----------------|------------------------|
| AI02 Service Binding for retrieval | Direct AI Search `search()` call |
| Assumed text lessons with sections | Video transcripts from Stream AI captions |
| Citations by section heading | Citations by lesson title |dco
| Vector-only search (bge-m3) | Hybrid search (vector + BM25 keyword) |
| No reranking | Built-in bge-reranker |
| ~300 lines | ~200 lines |
