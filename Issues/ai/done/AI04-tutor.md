# AI04: Tutor — Grounded Q&A

- **Type:** AFK
- **Week:** 3
- **Blocked by:** AI01 (Vectorize must have indexed lessons with transcripts), AI03 (LLM Gateway)
- **PR target:** ~200 lines

## What to build

Grounded Q&A engine. Learner asks a question about video lesson content → AI answers with citations to the lesson.

**One endpoint:**

`POST /tutor/ask` — body: `{ question, lesson_id, course_id, org_id }`
→ response: `{ answer, citations: [{ lesson_title, excerpt, score }], scope_expansion_suggested? }`

**Behavior:**
1. **Embed the question** via Workers AI:
   ```typescript
   const embedding = await env.AI.run("@cf/qwen/qwen3-embedding-0.6b", { text: question });
   const vector = embedding.data[0]; // 1024-dim
   ```

2. **Retrieve relevant vectors** from Vectorize:
   ```typescript
   const results = await env.VECTORIZE_INDEX.query(vector, {
     topK: 5,
     returnMetadata: true,
     filter: {
       lesson_id: lesson_id,   // Scope to this lesson
       org_id: org_id,         // Multi-tenant isolation
     },
   });
   ```

3. **Filter by score threshold** (0.5). If no matches → `"I couldn't find that in this lesson"` + `scope_expansion_suggested: true` (don't call AI03).

4. **Extract content + metadata** from Vectorize results:
   ```typescript
   const chunks = results.matches
     .filter(m => m.score >= 0.5)
     .map(m => ({
       excerpt: m.metadata.content.substring(0, 300),
       title: m.metadata.title,
       score: m.score,
       lesson_id: m.metadata.lesson_id,
       course_id: m.metadata.course_id,
     }));
   ```

5. **Build grounded prompt**:
   ```
   Answer the question using ONLY the provided content below.
   If the answer is not in the content, say "I couldn't find that in this lesson."
   Cite the lesson title for each fact. Be concise.

   CONTENT:
   [Lesson: Lumera Unit 1 - Python Fundamentals]
   Welcome to Python fundamentals. Today we're going to cover variables,
   data types, and how to write your first function.

   QUESTION: What is a variable?
   ```

6. **Call AI03 Service Binding** → `POST /generate` (tier=standard)

7. **Parse response** → extract citations → return to caller

**Scope expansion:**
- Default: filter by `lesson_id` + `org_id`
- `expand_scope: "module"` → remove `lesson_id` filter, add `module_id`
- `expand_scope: "course"` → filter only by `course_id` + `org_id`

**Metadata source (stub):**
- Currently: metadata comes from Vectorize results (title, lesson_id, course_id are stored with each vector)
- Future LMS integration: see `LMS_INTEGRATION` marker in code — replace with `GET /api/v1/lessons/{id}`

**No conversation history in this slice** — stateless Q&A. History is post-MVP.

## Wrangler Configuration

```jsonc
{
  "ai": { "binding": "AI" },
  "vectorize": [
    {
      "binding": "VECTORIZE_INDEX",
      "index_name": "lms-lessons"
    }
  ],
  "services": [
    {
      "binding": "AI_GATEWAY",
      "service": "ai-gateway"
    }
  ]
}
```

## Acceptance criteria

- [ ] Ask question about video lesson content → cited answer with lesson title + excerpt
- [ ] Ask question not in lesson → `"I couldn't find that"` + `scope_expansion_suggested: true`
- [ ] Expand scope to module → wider Vectorize filter, answer returned
- [ ] Expand scope to course → even wider, answer returned
- [ ] Answer is grounded — prompt enforces "use ONLY provided content"
- [ ] Works with both transcript-backed (815 chars) and metadata-only fallback lessons (45 chars)
- [ ] Score threshold filtering (0.5) — low-relevance chunks excluded
- [ ] If Vectorize returns no matches → responds "not found" without calling AI03
- [ ] Metadata (title, lesson_id, course_id) used for citations — sourced from Vectorize metadata
- [ ] Integration test: index video via AI01 → embed question → query Vectorize → call AI03 → get cited answer
- [ ] Unit tests: prompt construction, citation parsing, scope expansion logic, groundedness check
- [ ] **Observability:** Full trace shows: embed question → Vectorize query → AI03 generate → response
- [ ] **Observability:** Retrieval span shows `topK`, `score_threshold`, match count
- [ ] **Observability:** `scope_expansion` flag captured, citations count (`citations.count: N`)

## What Changed From Previous Iteration

| Before (AI Search) | After (Vectorize) |
|-------------------|-------------------|
| `env.AI_SEARCH.get(instance).search()` | `env.AI.run(embedding_model)` + `env.VECTORIZE_INDEX.query(vector)` |
| Hybrid search (vector + keyword) auto | Vector-only similarity (cosine). Keyword search re-addable later. |
| Auto-reranking via bge-reranker | Score threshold filtering (0.5). Reranking re-addable later. |
| No manual embedding | Must embed question before querying |
| Metadata from AI Search filters | Metadata from Vectorize `returnMetadata: true` |
| `lesson_id` filter on AI Search | `lesson_id` filter on Vectorize metadata index |
| ~200 lines | ~200 lines (same complexity, different API) |
