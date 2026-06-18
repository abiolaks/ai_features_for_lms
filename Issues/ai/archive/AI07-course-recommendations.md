# Slice 7: Course Recommendations

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 3, Slice 5
- **Blocked by (external):** None (uses mock platform catalogue + learner context)
- **User stories covered:** 8–12

## Parent

`docs/vertical-slices-phase-1.md` — Slice 7: Course Recommendations

## What to build

Three recommendation surfaces in one service:

**1. "Recommended for You"** — dashboard top-3, AI-powered when available.

**2. "Because You Completed X"** — catalogue sidebar, triggered by a completed course.

**3. "What to Take Next"** — post-completion suggestion after finishing a course.

Endpoints:

- `GET /recommendations/dashboard?learner_id={id}&org_id={org}` → top 3 recommendations
- `GET /recommendations/because?learner_id={id}&org_id={org}&completed_course_id={id}` → suggestions based on completion
- `GET /recommendations/next?learner_id={id}&org_id={org}&course_id={id}` → what to take next

**AI path (happy path):**
1. Fetch learner profile from Slice 5 + catalogue + learner context from Slice 0
2. Build prompt with profile signals and course data
3. Call Slice 3 (tier=standard) for personalized recommendations with one-sentence reasons

**Fallback cascade (when AI is unavailable):**

| Priority | Source | Behavior |
|----------|--------|----------|
| 1 | Org-curated defaults | Admin-configured list from mock platform (`org_context.defaults`) |
| 2 | Popular-in-org | Most-enrolled courses in the learner's org (from mock learner context) |
| 3 | Platform-wide popular | Most-enrolled courses across all orgs (from mock catalogue) |

Fallback recommendations include `source: "fallback"` and `tier` (which fallback level was used) so the UI can distinguish them visually. The widget **never** returns empty — platform-wide popular is the absolute floor.

**Caching:** Results cached per learner for 24 hours. Cache keyed on `learner_id + endpoint`. In-memory LRU cache via `cachetools.TTLCache` by default (env-configurable to Redis later via adapter). Cache TTL configurable via `CACHE_TTL_HOURS`. See `Issues/TECH_PRINCIPLES.md`.

## Acceptance criteria

- [ ] AI available → dashboard returns 3 personalized recommendations with one-sentence reasons
- [ ] AI available → "because you completed" returns suggestions tied to the completed course
- [ ] AI available → "what to take next" returns post-completion suggestions
- [ ] AI unavailable → falls back to org-curated defaults if configured
- [ ] No org defaults → falls back to popular-in-org courses
- [ ] No org data → falls back to platform-wide popular courses
- [ ] Widget never returns empty (at minimum, platform-wide popular)
- [ ] Fallback results include `source: "fallback"` and `tier` field for UI differentiation
- [ ] Same learner calls same endpoint within 24h → cached result returned (no re-computation)
- [ ] Unit tests: full fallback cascade (all 4 states: AI → org defaults → popular-in-org → platform-wide)
- [ ] Unit tests: cache hit/miss behavior, TTL expiration
- [ ] Integration tests: start with Slice 3 up → verify AI recs; kill Slice 3 → verify fallback

## Blocked by

- Slice 0 (mock platform for catalogue, learner context, org defaults)
- Slice 3 (LLM Gateway)
- Slice 5 (Learner Profile Service)
