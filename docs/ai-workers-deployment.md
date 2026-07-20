# AI Workers — Deployment & Testing Log

**Date:** 2026-07-10  
**Account:** yomi-alarape (Yomi.alarape@gmail.com's Account)  
**Account ID:** `6a42fe51d00d9ba921124c3f6e7ed092`

---

## 1. Deployed Workers

| Worker | URL | Bindings | CORS |
|--------|-----|----------|:----:|
| **ai-gateway** | `https://ai-gateway.yomi-alarape.workers.dev` | AI (Llama 3.2 / Mistral 7B), D1 (`lms-platform`), KV (`LMS_CACHE`) | ❌ Internal |
| **ai-indexing** | `https://ai-indexing.yomi-alarape.workers.dev` | AI, Stream, R2 (`lms-content-staging`), Vectorize (`lms-lessons`), Queue (`indexing-jobs`) | ❌ Internal |
| **ai-tutor** | `https://ai-tutor.yomi-alarape.workers.dev` | AI, Vectorize (`lms-lessons`), DO (`TutorSession`), Service→ai-gateway | ✅ |
| **ai-paths** | `https://ai-paths.yomi-alarape.workers.dev` | Service→ai-gateway | ✅ |
| **ai-insights** | `https://ai-insights.yomi-alarape.workers.dev` | Service→ai-gateway | ❌ Internal |

**Not deployed (stubs — no `src/index.ts`):**
- ai-dashboard, ai-recommendations

---

## 2. Secrets Configured

### ai-indexing
| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Stream API access |
| `CLOUDFLARE_STREAM_API_TOKEN` | Stream API auth |
| `LMS_GATEWAY_URL` | LMS backend URL |
| `LMS_INTERNAL_KEY` | LMS auth key |
| `LMS_WEBHOOK_SECRET` | Protects `/index`, `/backfill`, `/deindex` endpoints |

### ai-paths
| Secret | Purpose |
|--------|---------|
| `LMS_GATEWAY_URL` | LMS backend URL (profile/catalogue/progress) |
| `LMS_INTERNAL_KEY` | LMS auth key |

### ai-tutor & ai-gateway
No secrets needed — use service bindings and Workers AI natively.

### ai-insights
| Secret | Purpose |
|--------|---------|
| `LMS_GATEWAY_URL` | LMS backend URL (attempt, assessment, progress, module lessons) |
| `LMS_INTERNAL_KEY` | LMS auth key |

---

## 3. CORS Configuration

Allowed origins (in `workers/shared/cors.ts`):
- `https://learning.lumerax.co`
- `https://lms-staging.azurewebsites.net`

Only **ai-tutor** and **ai-paths** serve CORS headers (they're browser-facing).  
ai-gateway and ai-indexing are internal services — no CORS needed.

---

## 4. Content Indexed

**14/16** Cloudflare Stream videos indexed into Vectorize (`lms-lessons`) under `org_id: dev-org`.

Courses detected in transcripts:
- AI Foundations for SME Adoption
- AI-Driven Business Innovation (Machine Learning types & techniques)
- Effective Presentation Skills (storytelling, confidence, 5-message rule)
- Jira Tutorial for Beginners

To index under a real org_id:
```bash
curl -X POST https://ai-indexing.yomi-alarape.workers.dev/backfill \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <LMS_WEBHOOK_SECRET>" \
  -d '{"org_id": "your-org-id"}'
```

---

## 5. D1 Budget Table (`org_budgets`)

**Database:** `lms-platform` (D1)  
**Existing rows:**

| org_id | monthly_token_cap | tokens_used |
|--------|------------------:|------------:|
| `org-test` | 100,000 | 2,796 |
| `org-broke` | 10 | 10 (exhausted) |

**Add a budget:**

Via Cloudflare Dashboard: **Workers & Pages → D1 → lms-platform → Console**
```sql
INSERT INTO org_budgets (org_id, monthly_token_cap, tokens_used_this_period, billing_period_start)
VALUES ('your-org-id', 500000, 0, 1751328000);
```

Via CLI:
```bash
cd workers/ai-gateway
wrangler d1 execute lms-platform --remote --command "
  INSERT INTO org_budgets (org_id, monthly_token_cap, tokens_used_this_period, billing_period_start)
  VALUES ('your-org-id', 500000, 0, 1751328000);
"
```

Budget is enforced automatically — gateway returns `429 budget_exhausted` when limit reached.

---

## 6. API Contracts

### AI Gateway — `POST /generate`
```json
// Request
{
  "messages": [{"role": "user", "content": "What is ML?"}],
  "tier": "standard",          // "standard" (Llama 3.2) or "quality" (Mistral 7B)
  "org_id": "your-org-id"
}
// Response
{
  "response": "Machine learning is...",
  "model_used": "@cf/meta/llama-3.2-3b-instruct",
  "provider": "cloudflare",
  "tokens_used": 85,
  "throttle_warning": false
}
```

### AI Gateway — `POST /stream`
Same request body, returns `text/event-stream` (SSE) with `{type: "token", text: "..."}` events.

### AI Indexing — `POST /index` (webhook auth required)
```json
// Request (Header: X-Webhook-Secret)
{
  "event": "publish",
  "org_id": "your-org-id",
  "entity": {
    "id": "lesson-123",
    "title": "Introduction to AI",
    "contentType": "video",
    "cloudflareVideoId": "abc123",
    "streamStatus": "ready"
  }
}
// Response: { "status": "queued" }
```

### AI Indexing — `POST /backfill` (webhook auth required)
```json
// Request: { "org_id": "your-org-id" }
// Response: { "status": "queued", "queued": 16, "skipped": 3 }
```

### AI Indexing — `POST /extract-pdf` (webhook auth required)
```json
// Request: { "r2Key": "pdfs/course.pdf", "lesson_id": "123", "org_id": "x", "title": "..." }
// Response: { "status": "queued", "chars": 5000, "message": "..." }
```

### AI Tutor — `POST /tutor/ask`
```json
// Request
{
  "question": "What is supervised learning?",
  "learner_id": "user-123",
  "lesson_id": "lesson-456",
  "course_id": "course-789",
  "org_id": "your-org-id",
  "expand_scope": "course"     // "lesson" (default), "module", or "course"
}
// Response
{
  "answer": "Supervised learning is...",
  "citations": [
    {"lesson_title": "...", "excerpt": "...", "score": 0.61}
  ],
  "scope_expansion_suggested": false,
  "history_length": 2
}
```

### AI Tutor — `POST /tutor/clear`
```json
// Request: { "learner_id": "user-123" }
// Response: { "status": "cleared" }
```

### AI Paths — `POST /paths/generate`
```json
// Request
{
  "learner_id": "user-123",
  "org_id": "your-org-id",
  // Optional stub data (when LMS unreachable):
  "profile": {"skills": ["Python"], "goals": "Become ML engineer", "experience_level": "intermediate"},
  "catalogue": [{"title": "ML 101", "difficulty": "beginner", "category": "AI"}],
  "progress": [{"title": "Python Basics", "status": "completed"}]
}
// Response
{
  "path": [
    {"course_title": "ML 101", "order": 1, "why_this_fits": "Matches your ML goals"}
  ],
  "ai_status": "generated"      // "generated", "insufficient_data", or "degraded"
}
```

---

## 7. Test Scripts

| Script | Purpose |
|--------|---------|
| `scripts/test_workers.py` | Full smoke test — all 4 workers, 10 tests |
| `scripts/test_tutor.py` | Real tutor Q&A with indexed content |
| `scripts/index_all_videos.py` | Index all Stream videos (one-time setup) |

**Run:**
```bash
python3 scripts/test_workers.py   # No pip installs needed
python3 scripts/test_tutor.py
```

---

## 8. AI Tutor Verified Working

Tested with 4 follow-up questions across a conversation session:
- **Q1:** "What topics are covered?" → 4 topics identified, 15 citations
- **Q2:** "What are the three ML types?" → Correctly recalled from context
- **Q3:** "Tips for better speaking?" → recalled presentation course content
- **Q4:** "How can SMEs apply AI?" → business-specific answer from transcripts

---

## 9. LMS Integration Notes

For the LMS team:
- ai-tutor and ai-paths are **browser-facing** — CORS configured for `learning.lumerax.co` and `lms-staging.azurewebsites.net`
- ai-indexing expects `X-Webhook-Secret` header on POST endpoints
- ai-paths fetches profile/catalogue/progress from LMS via `LMS_GATEWAY_URL` + `LMS_INTERNAL_KEY`
- Use `expand_scope: "course"` in tutor queries until lesson-level metadata is populated
- Budget must exist in D1 `org_budgets` table for ai-gateway to process requests
