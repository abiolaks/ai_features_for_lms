# AI Indexing — Logs

How to watch and interpret logs during backfill/indexing.

---

## Watch Logs

```bash
cd workers/ai-indexing

# Live — all logs
npx wrangler tail

# Filter by video ID
npx wrangler tail --search "17bc6079"

# Filter by queue activity
npx wrangler tail --search "[queue]"
```

Leave it running in a terminal. Trigger a backfill or index, then watch.

---

## Success Flow

```
[queue] processing job for 17bc6079faade8bf4188d58520f88112
Video 17bc6079faade8bf4188d58520f88112: using existing captions
```
→ No error lines after → job acked → indexed.

---

## Failure Patterns

### Video not in Stream
```
[queue] processing job for <id>
[queue] job error: Failed to fetch VTT: 404
```
→ LMS sent `cloudflareVideoId` that doesn't exist. Check Stream.

### Caption generation timed out
```
Video <id>: generating AI captions...
[queue] job error: Caption generation timed out after 60s
```
→ Video has no captions and AI generation failed. Check video in Stream dashboard.

### Stream API error
```
Video <id>: using existing captions
Video <id> captioning failed: <error>, using metadata fallback
```
→ Worker fell back to title-only metadata. Lesson is indexed but only title/duration searchable, not full transcript.

### LMS callback failed
```
[notifyLms] failed to notify LMS for <id>
```
→ Indexing succeeded but LMS webhook unreachable. Lesson is still indexed — just LMS didn't get notified.

---

## Check Queue Backlog

```bash
# See how many jobs are waiting / in-flight
npx wrangler queues consumer describe indexing-jobs
```

---

## Verify Indexing

### Single lesson
```bash
curl -s "https://ai-indexing.yomi-alarape.workers.dev/status?lesson_id=<stream-video-id>" | python3 -m json.tool
```
→ `"indexed": true` when done.

### Whole org
```bash
curl -s "https://ai-indexing.yomi-alarape.workers.dev/status?org_id=<org-uuid>" | python3 -m json.tool
```
→ `"lessons_indexed": N` — count of distinct lessons.

---

## Dashboard vs wrangler tail

| Source | Unredacted? | Live? | Historical? |
|--------|-------------|-------|-------------|
| `wrangler tail` | Yes | Yes | No |
| Cloudflare Dashboard | URLs REDACTED | ~1min delay | Yes (persisted) |

Dashboard logs mask URL paths (`/captions/REDACTED`). Use `wrangler tail` for debugging.
