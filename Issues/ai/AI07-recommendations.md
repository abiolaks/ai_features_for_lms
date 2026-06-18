# AI07: Enhanced Course Recommendations

- **Type:** AFK
- **Week:** 5
- **Blocked by:** AI03 (LLM Gateway), LMS `/api/v1/courses/recommendations`, `/api/v1/catalog`, `/api/v1/learner/profile`, `/api/v1/progress/user`
- **PR target:** ~200 lines

## What to build

Enhances the LMS's existing recommendations with AI-generated "why this fits you" explanations. Caches results in KV for 24h.

**Endpoints:**

`GET /recommendations/dashboard?learner_id={id}&org_id={org}`
→ response: `{ recommendations: [{ course_title, lms_reason, ai_why_this_fits }] }`

`GET /recommendations/next?learner_id={id}&org_id={org}&course_id={id}`
→ response: `{ next_courses: [{ course_title, why_this_fits }] }`

**Behavior:**
1. Check KV cache → if hit, return immediately
2. Get LMS baseline recommendations: `GET /api/v1/courses/recommendations`
3. Get learner profile + progress for personalization context
4. Get catalogue for course details
5. For each LMS recommendation, call AI03 to generate `ai_why_this_fits`:
   ```
   Learner profile: { skills, goals, completed_courses }
   Course: { title, difficulty, category }
   Write ONE sentence explaining why this course fits this specific learner.
   Reference their skills, goals, or progress. Be specific, not generic.
   ```
6. Merge: LMS recommends what → AI explains why
7. Cache in KV: `recs:{org_id}:{learner_id}` → 24h TTL

**Fallback cascade:**
1. KV cache hit → instant return
2. LMS recs available → enhance with AI explanations
3. LMS recs unavailable → generate recs from catalogue alone via AI03
4. AI03 unavailable → return LMS recs without AI explanations (degraded)

## Acceptance criteria

- [ ] Each recommendation has both LMS reason + AI-generated `why_this_fits`
- [ ] AI explanations reference learner's actual skills, progress, goals (not generic)
- [ ] KV cache: second call within 24h returns instantly (verified via timing)
- [ ] LMS recs unavailable → AI generates recs from catalogue alone
- [ ] AI03 unavailable → returns LMS recs without explanations, `ai_status: "degraded"`
- [ ] Unit tests: cache hit/miss, fallback cascade, prompt construction
- [ ] **Observability:** KV cache span shows `cache.hit: true/false`
- [ ] **Observability:** Fallback cascade visible in trace (LMS recs → AI03 → KV cache)
- [ ] **Observability:** Degraded response marked with `ai_status: "degraded"` in span
