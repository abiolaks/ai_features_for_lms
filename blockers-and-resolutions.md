# Blockers & Resolutions

> Record of every blocker encountered during implementation, how it was diagnosed,
> and how it was resolved. Prevents repeating the same debugging sessions.

---

## BLOCKER: AI01 — VTT Fetch Returns 404

**Slice:** AI01 Content Indexing
**Time to resolve:** —

### Symptom

Calling `POST /index` with a video lesson returned:
```json
{"status":"fallback","transcript_source":"none","error":"Caption generation timed out after 60s"}
```

The worker was timing out trying to generate captions, even though the video already had captions ready.

### Diagnosis

1. Added `/captions/:id` diagnostic endpoint → showed captions exist (`status: "ready"`)
2. Tried REST API VTT fetch → 404 "Could not route to ... perhaps your object identifier is invalid?"
3. Added `/env-check` endpoint → **secrets were empty**: `CLOUDFLARE_ACCOUNT_ID: len=0`, `CLOUDFLARE_STREAM_API_TOKEN: len=0`
4. `wrangler secret list` showed both secrets existed → they were set but had empty values

### Root Cause

The REST API URL was being built with an empty account ID:
```
https://api.cloudflare.com/client/v4/accounts//stream/{videoId}/captions/en/vtt
                                                     ^^ empty!
```

With no account ID and no auth token, the request couldn't be routed → 404.

### Resolution

**Step 1:** Create a Cloudflare API token with proper permissions:

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token" → "Create Custom Token" → "Get Started"
3. Configure:
   - **Token name:** `ai-indexing-stream`
   - **Permission 1:** Account → Stream → Read
   - **Permission 2:** Account → Account Settings → Read
   - **Account Resources:** Include → All accounts
4. Create and copy the token immediately

**Step 2:** Set secrets:

```bash
cd workers/ai-indexing
npx wrangler secret put CLOUDFLARE_STREAM_API_TOKEN
# Paste the API token

npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
# Paste: 6a42fe51d00d9ba921124c3f6e7ed092
```

**Step 3:** Redeploy:

```bash
npx wrangler deploy
```

### Verification

After fix, calling the indexing endpoint returned:
```json
{"status":"indexed","transcript_source":"existing","content_length":815}
```

The 815-character transcript was successfully extracted from the VTT file.

### Lessons Learned

1. **Stream binding ≠ REST API.** The Worker's `env.STREAM` binding handles video management but has no VTT-content-fetch method. The REST API bridge needs valid secrets.

2. **`wrangler secret put` can create empty secrets.** The secrets existed in the list but had zero-length values. Always verify with a diagnostic endpoint after setting secrets.

3. **Always add a `/env-check` diagnostic endpoint early.** It saved significant debugging time. Without it, we'd still be guessing whether secrets were loaded.

4. **Diagnostic endpoints (`/captions/:id`, `/videos`, `/env-check`) are worth the code.** They don't affect the API contract and can be removed or auth-gated later.

---

## BLOCKER: AI01 — Source Code Was a Diagnostic Stub

**Slice:** AI01 Content Indexing
**Time to resolve:** —

### Symptom

All 16 unit tests failed:
- 6 validation tests: expected 405/400/404, got 200
- 4 VTT parsing tests: `extractTextFromVTT is not a function`
- 6 route tests: expected `{status:"indexed"}`, got `{tokenLen, acctLen}`

### Diagnosis

The deployed `src/index.ts` contained a diagnostic stub instead of the indexing pipeline:

```typescript
// What was there:
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const tokenLen = (env.CLOUDFLARE_STREAM_API_TOKEN || '').length;
    return Response.json({ tokenLen, acctLen, vttUrl, fetchResult });
  }
};
```

This was a connectivity test — it checked whether Cloudflare Stream API tokens were configured but didn't implement any of the AI01 routes.

### Root Cause

The original AI01 implementation was overwritten with a diagnostic stub during earlier debugging of the Stream API connectivity. The stub was deployed and never reverted.

### Resolution

Rewrote `src/index.ts` from scratch following the AI01 spec (`Issues/ai/done/AI01-content-indexing.md`):

- Added all routes: `/index`, `/deindex`, `/backfill`
- Added input validation for all routes
- Implemented `extractTextFromVTT()` with export
- Implemented full video pipeline (check → generate → poll → fetch → upload)
- Added diagnostic endpoints: `/videos`, `/captions/:id`, `/env-check`

**Result:** 16/16 tests passing, deployed and verified live.

### Lessons Learned

1. **Run the test suite before and after every deploy.** The stub had 0/16 tests passing and was deployed anyway. A `pre-push` hook or CI check would have caught this.

2. **Diagnostic code should live in separate branches or be clearly marked.** The stub looked like production code to anyone not reading it carefully.

---

---

## BLOCKER: AI01 — Transcript Exceeds Vectorize Metadata Limit

**Slice:** AI01 Content Indexing
**Time to resolve:** ~30 min

### Symptom

Indexing the 20-minute Jira tutorial returned:
```json
{
  "status": "fallback",
  "transcript_source": "none",
  "content_length": 21,
  "error": "VECTOR_UPSERT_ERROR (code = 40016): oversized metadata for vector id=\"lesson-df8f7fb...\"; the compact JSON representation of the metadata must not exceed 10240 bytes, got 21326 bytes"
}
```

The 21KB transcript exceeded Vectorize's 10KB metadata limit.

### Diagnosis

1. Checked the Jira video captions via `/captions/:id` — captions existed and were ready
2. Manually tried to index → 40016 error with exact byte counts
3. Confirmed: Vectorize metadata limit is 10,240 bytes per vector
4. The full transcript was being stored in a single `content` metadata field

### Root Cause

`embedAndUpsert()` stored the entire transcript as one vector's metadata. Long videos produce large transcripts. Vectorize has a hard 10KB metadata limit.

### Resolution

Added `chunkText()` function that splits long content at ~2000-char sentence boundaries:

```typescript
const CHUNK_SIZE = 2000;

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + CHUNK_SIZE;
    if (end < text.length) {
      const period = text.lastIndexOf(". ", end);
      const newline = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const breakpoint = Math.max(period, newline, space);
      if (breakpoint > start + CHUNK_SIZE / 2) {
        end = breakpoint + 1;
      }
    }
    chunks.push(text.substring(start, end).trim());
    start = end;
  }
  return chunks;
}
```

Each chunk gets its own vector with `chunk_index` and `total_chunks` metadata. IDs: `lesson-{id}-chunk0`, `lesson-{id}-chunk1`, etc.

Also added pre-cleanup on re-index to avoid stale vectors. Uses batched `getByIds` (20-ID limit per call, 3 batches for 60 IDs).

### Verification

Jira tutorial successfully indexed: 21,113 chars → 11 chunks. Tutor returns 6 citations with full 2000-char excerpts.

### Lessons Learned

1. **Always check platform limits before building.** The 10KB metadata limit wasn't in our initial design.
2. **Chunking at sentence boundaries preserves semantic coherence.** Splitting mid-word damages embedding quality.
3. **Batch Vectorize operations.** getByIds has a 20-ID limit per call, not documented obviously.

---

## BLOCKER: AI01 — Embedding Model Dimension Mismatch

**Slice:** AI01 Content Indexing
**Time to resolve:** ~20 min

### Symptom

Tutor queries returned "I couldn't find that" even after successful indexing. Diagnostic search showed vectors with scores like -0.02 and 0.012 — effectively random.

### Diagnosis

1. Checked Vectorize index: `lms-lessons` created with 1024 dimensions
2. Checked embedding model: `@cf/qwen/qwen3-embedding-0.6b` outputs 384-dim vectors
3. 384-dim vectors being stored in a 1024-dim index → padding/truncation → garbage scores

### Root Cause

The index was created at 1024 dimensions (from earlier experimentation) but the code used qwen3 which produces 384-dim. Workers AI silently accepted the dimension mismatch, producing nonsense vectors.

### Resolution

Switched both `ai-indexing` and `ai-tutor` to use `@cf/baai/bge-large-en-v1.5` which produces 1024-dim vectors:

```typescript
// Before:
const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";  // 384-dim

// After:
const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";     // 1024-dim
```

Re-indexed all videos after the switch. Scores went from -0.02 to 0.83.

### Verification

Diagnostic search: `"How do list comprehensions work?"` → top match score 0.91 with correct content.

### Lessons Learned

1. **Check model dimensions before creating Vectorize indexes.** Cloudflare's model catalog lists dimensions.
2. **Dimension mismatches don't throw errors** — Workers AI silently pads/truncates, producing garbage.
3. **Always test with a known query after indexing.** Our diagnostic search caught this immediately.

---

## BLOCKER: AI01 — PDF Text Extraction: Four Failed Approaches Before unpdf

**Slice:** AI01 Extend to PDF/PPT
**Time to resolve:** ~95 min cumulative

### The Journey

**Attempt 1 — BT/ET Regex (failed):** Parsed PDF binary for text operators. Works only for uncompressed PDFs. All 31 R2 PDFs use FlateDecode compression → garbage output (raw PDF syntax).

**Attempt 2 — pdf-parse npm (failed):** Installed `pdf-parse`, which wraps pdfjs-dist. Depends on Node.js `Buffer`. Workers don't have Node.js Buffer even with `nodejs_compat`. Dynamic import failed silently, fell back to regex.

**Attempt 3 — Python Worker with PyPDF2 (failed):** Scaffolded `workers/pdf-extractor/` Python Worker. PyPDF2 is pure Python but not in Pyodide's pre-built package list for Python Workers. `ModuleNotFoundError: No module named 'PyPDF2'`.

**Attempt 4 — pyodide package list check (abandoned):** Tried to check if PyPDF2 could be added to Pyodide. It can't without a custom Pyodide build.

### Resolution

**Attempt 5 — unpdf (success):** Found `unpdf` via web search. 1.4M weekly downloads, built specifically for Cloudflare Workers. Wraps pdfjs-serverless (a Workers-compatible build of PDF.js).

```typescript
// Final working code:
async function extractTextFromPdfBufferAsync(buffer: ArrayBuffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return (typeof text === "string" ? text : text.join("\n")).trim();
}
```

### Verification

- Module 4 Core Lecture: 12,476 chars of readable text ("AI-Powered Decision Intelligence for SMEs...")
- Code of Conduct: 10,371 chars ("Wragby Code of Conduct Document Classification: CONFIDENTIAL...")
- Bundle size: 2.3MB (unpdf ~1.1MB), under 3MB Worker limit

### Lessons Learned

1. **Web search before coding.** unpdf was the answer all along — we spent 95 min on approaches that were never going to work.
2. **"Cloudflare Workers compatible" in npm keywords is gold.** unpdf has it; pdf-parse doesn't.
3. **Python Workers are promising but package support is limited.** Don't bet on arbitrary PyPI packages working yet.
4. **Always test extraction quality with a preview endpoint.** Our `/diag-extract?preview=1` showed real text vs garbage instantly.
5. **PDF compression (FlateDecode) is near-universal.** Regex approaches work on <5% of real-world PDFs.

---

## Summary of All Blocks Resolved

| Blocker | Time | Root Cause | Fix |
|---------|------|-----------|-----|
| VTT fetch 404 | ~90 min | Empty secrets (CLOUDFLARE_STREAM_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) | Created API token + set secrets via `wrangler secret put` |
| 16/16 tests failing | ~30 min | Source was diagnostic stub, not pipeline | Rewrote `src/index.ts` with full AI01 implementation |
| Embedding dimension mismatch | ~20 min | Index at 1024-dim, qwen3 model outputs 384-dim | Switched to bge-large-en-v1.5 (1024-dim) in both workers |
| Transcript too large for metadata | ~30 min | 21KB transcript exceeds 10KB Vectorize metadata limit | Added chunkText() splitting at 2000-char sentence boundaries |
| pdf-parse fails in Workers | ~60 min | pdf-parse depends on Node.js Buffer, not available in Workers runtime | Replaced with unpdf — Workers-compatible, 1.4M weekly downloads, handles FlateDecode |
| Python Worker can't import PyPDF2 | ~20 min | PyPDF2 not in Pyodide's pre-built package list for Python Workers | Abandoned Python Worker approach; unpdf in TypeScript worker works |
| BT/ET regex fails for compressed PDFs | ~15 min | All 31 R2 PDFs use FlateDecode compression; regex only reads uncompressed streams | Added unpdf which decompresses streams via built-in PDF.js |

