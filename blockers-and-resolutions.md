# Blockers & Resolutions

> Record of every blocker encountered during implementation, how it was diagnosed,
> and how it was resolved. Prevents repeating the same debugging sessions.

---

## BLOCKER: AI01 — VTT Fetch Returns 404

**Date:** 2026-07-02
**Slice:** AI01 Content Indexing
**Time to resolve:** ~90 minutes

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

3. **Always add a `/env-check` diagnostic endpoint early.** It saved ~30 minutes of debugging. Without it, we'd still be guessing whether secrets were loaded.

4. **Diagnostic endpoints (`/captions/:id`, `/videos`, `/env-check`) are worth the code.** They don't affect the API contract and can be removed or auth-gated later.

---

## BLOCKER: AI01 — Source Code Was a Diagnostic Stub

**Date:** 2026-07-02
**Slice:** AI01 Content Indexing
**Time to resolve:** ~30 minutes

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

## Summary of All Blocks Resolved

| Blocker | Time | Root Cause | Fix |
|---------|------|-----------|-----|
| VTT fetch 404 | ~90 min | Empty secrets (CLOUDFLARE_STREAM_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) | Created API token + set secrets via `wrangler secret put` |
| 16/16 tests failing | ~30 min | Source was diagnostic stub, not pipeline | Rewrote `src/index.ts` with full AI01 implementation |

**Total AI01 debugging time:** ~2 hours (blamed on silent state: empty secrets + incorrect source code)
