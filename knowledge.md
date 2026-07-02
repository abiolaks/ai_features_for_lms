## 2026-07-02 — How does AI indexing work end-to-end? (Chunking, Embedding, Sources)

**Question:** How does the ai-indexing work and how does it embed and store the chunks, and how does it know the sources it uses?

**Answer:**

AI indexing has three layers, only one of which is our code:

### Layer 1: Content Extraction (Our Worker)

The `ai-indexing` worker receives LMS webhooks and fetches video transcripts from Cloudflare Stream:

```
LMS webhook → Worker → Fetch VTT via REST API → Upload JSON to AI Search
```

For **video lessons**: checks captions via Stream binding, fetches VTT via REST API, extracts text with `extractTextFromVTT()`, uploads `{ content, metadata }` JSON to AI Search.

For **text/non-video**: builds a metadata-only string (`"Title. type. Duration: Xs."`) and uploads that.

The VTT fetch requires two secrets (`CLOUDFLARE_STREAM_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`) because the Stream binding has no VTT-content-fetch method — the REST API is the only path.

### Layer 2: AI Search (Cloudflare Managed — we never touch this)

Once we call `instance.items.upload(key, JSON.stringify({ content, metadata }))`, Cloudflare takes over:

1. **Indexing job** scans all uploaded files
2. **Chunks** content into ~512-token pieces (respecting sentence boundaries)
3. **Embeds** each chunk with `@cf/qwen/qwen3-embedding-0.6b` → 384-dimensional vectors
4. **Stores** vectors in Cloudflare's Vectorize database

The instance config: chunk_size=512, chunk_overlap=64, reranking via bge-reranker-base, RRF fusion (keyword + vector combined).

Content is NOT searchable immediately — an indexing job must be triggered (`wrangler ai-search jobs create`) to process the uploaded files.

### Layer 3: How chunks link to sources

Every chunk carries its parent item's full metadata:
```json
{
  "score": 0.6356,
  "text": "{\"content\":\"...\",\"metadata\":{\"title\":\"...\",\"lesson_id\":\"...\",\"course_id\":\"...\",\"org_id\":\"...\"}}",
  "item": { "key": "lesson-lumera-unit1.json" }
}
```

The chunk is never orphaned — it always references back to its source lesson/course/org. The Tutor uses these metadata fields to filter searches (`filter: "lesson_id = X"`).

**Key insights:**
- We never write chunking or embedding code — AI Search does it all
- Content → raw JSON → indexing job → chunks + vectors → searchable
- Three AI Search instances per org (lessons, courses, assessments) for physical multi-tenant isolation
- Chunks carry full metadata back to their source
- Metadata fields (title, lesson_id, course_id, org_id, transcript_source) are all filterable in search queries

**Related files:**
- `workers/ai-indexing/src/index.ts`
- `workers/ai-indexing/code_walkthrough.md`
- `blockers-and-resolutions.md`
- `notes-steps-implementation.md`

---

## 2026-07-02 — BLOCKER: VTT Fetch Returns 404 (Empty Secrets)

**Symptom:** Video indexing returned `"status":"fallback"` with "Caption generation timed out after 60s"

**Root cause:** `CLOUDFLARE_STREAM_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets were registered in `wrangler secret list` but had **empty values** (len=0). The REST API URL was built as `.../accounts//stream/...` (empty account ID) → 404.

**Resolution:**
1. Created Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens
   - Permission 1: Account → Stream → Read
   - Permission 2: Account → Account Settings → Read
2. Set via `npx wrangler secret put CLOUDFLARE_STREAM_API_TOKEN`
3. Set via `npx wrangler secret put CLOUDFLARE_ACCOUNT_ID` (value: `6a42fe51d00d9ba921124c3f6e7ed092`)
4. Redeployed → immediate fix, VTT fetch returned 815 chars of transcript

**Time spent:** ~90 minutes
**Prevention:** Always verify secrets with a `/env-check` diagnostic endpoint after setting them. `wrangler secret list` can show secrets that exist but have zero-length values.

---

## 2026-07-02 — BLOCKER: Diagnostic Stub Instead of Pipeline

**Symptom:** All 16 unit tests failed. Worker returned `{tokenLen, acctLen, fetchResult}` instead of `{status:"indexed"}`.

**Root cause:** `src/index.ts` contained a connectivity diagnostic stub that only checked Stream API token lengths. The actual AI01 pipeline was never implemented (or was overwritten during debugging).

**Resolution:** Rewrote the full pipeline from the AI01 spec with all routes, validation, VTT parsing, and both text/video indexing paths. 16/16 tests now pass.

**Time spent:** ~30 minutes
**Prevention:** Run `npx vitest run` before every deploy. The stub was deployed with 0/16 tests passing.

---

## 2026-07-02 — How to verify AI indexing works end-to-end

**Steps:**
```bash
# 1. Check secrets loaded
curl -s https://ai-indexing.yomi-alarape.workers.dev/env-check

# 2. Index a real video
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/index \
  -H "Content-Type: application/json" \
  -d '{"event":"publish","org_id":"org-test","entity":{...}}'

# 3. Trigger indexing job
npx wrangler ai-search jobs create org-test-lessons --namespace lms-platform

# 4. Monitor progress
npx wrangler ai-search stats org-test-lessons --namespace lms-platform

# 5. Search
npx wrangler ai-search search org-test-lessons --namespace lms-platform --query "query"
```

Dashboard verification: Workers & Pages → ai-indexing (invocations), AI → AI Search → org-test-lessons (indexed count + search), Stream → video → Captions tab.

---

## 2026-07-02 — DECISION: REST API for VTT, not Stream Binding

**Context:** The Stream binding (`env.STREAM`) handles captions.list(), captions.generate(), captions.upload(), captions.delete() — but has NO method to read VTT content. We need the actual transcript text.

**Decision:** Use the Cloudflare REST API to fetch VTT: `GET /accounts/{id}/stream/{video}/captions/{lang}/vtt`. This requires `CLOUDFLARE_STREAM_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets.

**Trade-offs:** Gain: reliable VTT access via standard REST API. Lose: two secrets to manage, one extra HTTP call per video index.

---

## 2026-07-02 — DECISION: Metadata-Only Fallback

**Context:** What happens if caption generation fails (no audio, API error, timeout)?

**Decision:** Upload metadata-only content (`"Title. type. Duration: Xs."`) as fallback instead of failing. The lesson remains findable by title — the Tutor returns degraded results rather than "not found."

**Trade-offs:** Gain: graceful degradation, no broken lessons. Lose: search precision is lower without full transcript.
