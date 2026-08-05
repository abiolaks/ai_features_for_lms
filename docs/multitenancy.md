# Multitenancy

How tenant (organization) isolation works across all AI workers, storage layers, and data flows.

---

## Architecture

```
LMS Frontend
  │  sends org_id in every request body/query param
  ▼
┌──────────────────────────────────────────────────────────────┐
│ AI Worker (any)                                              │
│                                                              │
│  ┌─► LMS REST API        tenant scoped by query param        │
│  ├─► Vectorize            filter: {org_id} on every query    │
│  ├─► D1 (ai-gateway)     WHERE org_id = ?, auto-provisioned  │
│  ├─► KV (cache)           key names embed org_id             │
│  └─► Durable Objects      one DO instance per learner        │
└──────────────────────────────────────────────────────────────┘
```

**There is no central tenant context, middleware, or resolver.** Each storage layer handles isolation independently using `org_id` as the partition key. The LMS frontend is trusted to send the correct `org_id` — authentication and org-membership are enforced by the LMS before it calls the AI workers.

---

## Isolation by Storage Layer

### 1. LMS REST API — Primary Enforcement

All learner/catalog/progress/admin data lives in the LMS database. Every AI worker calls the LMS API with the tenant as a query parameter:

```
GET  /api/v1/catalog?organization_id=<uuid>
GET  /api/v1/progress/user?userId=<uuid>          # LMS knows which org the user belongs to
GET  /api/v1/admin/progress/aggregate?organization_id=<uuid>
POST /api/v1/learner/profile                      # LMS resolves org from auth headers
```

The LMS enforces tenant boundaries. AI workers never see cross-org data because the LMS returns only the requesting org's records. This is the **primary enforcement layer** — all other layers are secondary.

**Module:** `workers/shared/fetch-lms.ts`, `workers/shared/lms-data.ts`

---

### 2. Vectorize — Metadata Filter + Post-Query Check

All content embeddings live in one shared Vectorize index (`lms-lessons`). Tenant isolation uses two mechanisms:

**a) Metadata filter at query time:**
```ts
env.VECTORIZE_INDEX.query(embedding, {
  filter: { org_id: orgId },
  topK: 50,
});
```

**b) Client-side post-query check:**
```ts
if (meta.org_id && orgId && meta.org_id !== orgId) continue;
```

**c) Vector ID naming avoids collisions:**
```
lesson-{org_id}-{entity_id}-chunk{i}
```

This means even if the filter somehow fails (bug), vectors from different orgs are stored under different keys and can't overwrite each other.

**Modules:** `workers/ai-indexing/src/index.ts` (write), `workers/ai-tutor/src/TutorSession.ts` (read), `workers/ai-assistant/src/AssistantSession.ts` (read), `workers/ai-recommendations/src/index.ts` (read)

---

### 3. D1 (ai-gateway) — Per-Org Budget Rows

One `org_budgets` table in the ai-gateway's D1 database:

```sql
CREATE TABLE org_budgets (
  org_id          TEXT PRIMARY KEY,
  monthly_token_cap      INTEGER NOT NULL DEFAULT 100000,
  tokens_used_this_period INTEGER NOT NULL DEFAULT 0,
  billing_period_start   INTEGER NOT NULL
);
```

Every operation is scoped by `org_id`:

```sql
SELECT * FROM org_budgets WHERE org_id = ?;              -- read budget
UPDATE org_budgets SET tokens_used_this_period = ... WHERE org_id = ?;  -- track tokens
```

**Auto-provisioning:** new orgs are created automatically on first use with a 100K monthly token cap:

```sql
INSERT OR IGNORE INTO org_budgets (org_id, monthly_token_cap, ...)
VALUES (?, 100000, 0, unixepoch());
```

If org-123 exhausts its tokens, it gets HTTP 429 — org-456 is unaffected.

**Module:** `workers/ai-gateway/src/index.ts`

---

### 4. KV Cache — Namespaced Keys

Cache entries embed `org_id` in the key name, guaranteeing no cross-org reads:

```
recs:{org_id}:{learner_id}           # Recommendations dashboard
recs:next:{org_id}:{learner_id}:{course_id}  # Next course recs after completion
```

TTL is 24h by default. Refreshing one org's cache never touches another org's entries.

**Module:** `workers/ai-recommendations/src/index.ts`

---

### 5. Durable Objects — Per-Learner Instances

Tutor (`TutorSession`) and Assistant (`AssistantSession`) use Cloudflare Durable Objects with deterministic routing:

```ts
env.TUTOR_SESSION.idFromName(`session-${learnerId}-${courseId}`)
env.ASSISTANT_SESSION.idFromName(`session-${learnerId}`)
```

Each DO instance stores conversation history in local SQLite:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**No explicit org isolation in the DO SQL schema** — and it doesn't need it. A DO instance is inherently single-learner. Since a learner always belongs to exactly one org, there is no cross-org risk. The `org_id` is passed in request bodies and used only to scope Vectorize queries inside the DO.

**Modules:** `workers/ai-tutor/src/TutorSession.ts`, `workers/ai-assistant/src/AssistantSession.ts`

---

## New Org Onboarding Flow

When a new organization is created in the LMS, two things must happen for AI features to work:

### ✅ Token Budget — Automatic

No action needed. The ai-gateway auto-provisions a 100K/month budget on first use via `INSERT OR IGNORE`.

### ❌ Content Indexing — Requires LMS Webhook

**The indexing worker does NOT scan for new orgs.** It is purely event-driven. The LMS must push content via webhooks.

For every lesson in the new org, the LMS backend sends:

```bash
curl -X POST https://ai-indexing.<subdomain>.workers.dev/index \
  -H "X-Webhook-Secret: <secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "publish",
    "org_id": "NEW-ORG-UUID",
    "entity": {
      "id": "lesson-uuid",
      "title": "Lesson Title",
      "contentType": "video",
      "cloudflareVideoId": "stream-video-id",
      "course_id": "course-uuid",
      "module_id": "module-uuid"
    }
  }'
```

**Going forward:** the LMS must fire `POST /index` on every lesson publish, `POST /deindex` on unpublish, and `POST /extract-pdf` for PDF/PPT uploads.

### Temporary Stopgap (if webhooks not built)

```bash
python3 scripts/backfill_all.py --org-id "NEW-ORG-UUID" --from-json export.json
```

Requires LMS admin to export content as JSON first. This is a stopgap — the target state is zero manual steps.

### Why the LMS Must Push

Stream (videos) and R2 (PDFs) are shared across all orgs — no org-level partitioning:

- **Stream:** all videos mixed together, no org metadata
- **R2:** all PDFs mixed together, UUID-based paths, no org metadata

Only the LMS database knows which content belongs to which org. The indexing worker has no way to auto-discover this mapping.

---

## Data Flow Summary

| Storage Layer | Isolation Mechanism | Automatic for New Org? |
|---|---|---|
| **LMS REST API** | Query parameter `organization_id=` | ✅ LMS handles this |
| **Vectorize** | Metadata `filter: {org_id}` + post-query check | ❌ LMS must fire `/index` webhooks |
| **D1 (token budgets)** | `WHERE org_id = ?` + `INSERT OR IGNORE` on first use | ✅ 100K default cap |
| **KV (cache)** | Key name `recs:{org_id}:...` | ✅ Created on first request |
| **Durable Objects** | One DO per learner (inherently single-org) | ✅ Created on first session |

---

## Trust Model

The AI workers **trust the LMS frontend** to send the correct `org_id`. There is no JWT claim verification or org-membership check in the workers themselves. The LMS is responsible for:

1. Authenticating the user
2. Determining which org the user belongs to
3. Passing the correct `org_id` in AI worker requests
4. Only sending content webhooks for lessons that belong to the claimed org

If the LMS sends a wrong `org_id`, the AI worker will use it — there is no server-side cross-check.
