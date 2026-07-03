# AI06: Learning Paths — Code Walkthrough

> `workers/ai-paths/src/index.ts` — 1 endpoint, ~280 lines

---

## Architecture

```
POST /paths/generate { learner_id, org_id }
  │
  ├─ [data.fetch span] ──────────────────────
  │   ├─ GET LMS /v1/learner/profile    (stub: body.profile)
  │   ├─ GET LMS /v1/catalog            (stub: body.catalogue)
  │   └─ GET LMS /v1/progress/user      (stub: body.progress)
  │
  ├─ Insufficient data check
  │   └─ No profile? No catalogue? → ai_status: "insufficient_data"
  │
  ├─ buildPrompt(profile, catalogue, progress)
  │   └─ Constructs curriculum designer prompt with skills, goals, courses, prereqs
  │
  ├─ [path.generate span] ───────────────────
  │   ├─ [ai_gateway.generate sub-span] ──
  │   │   └─ Service binding → AI_GATEWAY.fetch(POST /generate)
  │   │
  │   ├─ Gateway failed? → ai_status: "degraded"
  │   │
  │   └─ parsePath(llm.response, catalogue, progress)
  │       ├─ Extract JSON (handles markdown code blocks)
  │       ├─ Filter completed courses
  │       ├─ Validate prerequisite ordering
  │       │   └─ Track prereq_violations → surfaced in span
  │       └─ Limit to 5 courses
  │
  └─ Response { path: [...], ai_status }
```

---

## Key Functions

### `buildPrompt(profile, catalogue, progress)` — Line ~210

Takes three data sources and builds a structured prompt:
- **Profile:** skills, goals, experience, streak → wrapped in "LEARNER PROFILE" block
- **Catalogue:** title, difficulty, category, prerequisites → "AVAILABLE COURSES" list
- **Progress:** completed titles, in-progress with % → exclusion list

The LLM is instructed to return JSON: `{"courses":[{...}]}` with no surrounding text.

### `parsePath(response, catalogue, progress, pathSpan)` — Line ~250

Safely extracts structured data from LLM output:
1. **Extract JSON** — tries markdown code block extraction first, falls back to regex `{...}` match
2. **Parse** — accepts `courses` or `path` as array key, tolerates `title`/`course_title` fields
3. **Filter completed** — removes any course the learner already finished (safety net)
4. **Validate prerequisites** — walks the list, checks each course's prereqs were seen (or completed)
5. **Track violations** — counts how many courses had unmet prereqs → `pathSpan.prereq_violations`
6. **Limit** — returns at most 5 courses

### Span Helpers — Line ~58

`startSpan(name)` → `setAttr(ctx, key, val)` → `endSpan(ctx)` emit structured JSON to `console.log`:

```json
{"span":"path.generate","duration_ms":42,"course_count":3,"why_this_fits_count":3,"prereq_violations":0,"ai_status":"generated"}
```

Surfaced via `wrangler tail` / Workers Logs.

---

## Response States

| ai_status | When | path contents |
|-----------|------|---------------|
| `"generated"` | Normal — LLM produced valid path | Ordered courses with `why_this_fits` |
| `"insufficient_data"` | Empty catalogue, or no profile/goals | First 5 courses with generic message |
| `"degraded"` | AI03 gateway down, or LLM returned garbage | First 5 courses with empty `why_this_fits` |

---

## LMS Integration (Stub Mode)

Currently accepts data inline:
```json
{
  "learner_id": "l1",
  "org_id": "org-test",
  "profile": { "skills": ["python"], "goals": "..." },
  "catalogue": [{ "title": "...", "difficulty": "...", "category": "...", "prerequisites": [...] }],
  "progress": [{ "title": "...", "status": "completed", "progress_pct": 100 }]
}
```

When LMS APIs are live, uncomment the `LMS_INTEGRATION` blocks — the worker will fetch from:
- `GET /v1/learner/profile`
- `GET /v1/catalog`
- `GET /v1/progress/user?userId=X`

Needs secrets: `LMS_GATEWAY_URL` + `LMS_INTERNAL_KEY` (from LMS team).

---

## Test Coverage (20 tests)

| Group | Tests | What it verifies |
|-------|-------|-----------------|
| Validation | 5 | 405, 404, bad JSON, missing learner_id, missing org_id |
| Insufficient data | 2 | Empty catalogue → insufficient, no profile → browse view |
| Path generation | 3 | Full path, completed filtered, prereq validated |
| Degraded mode | 2 | Gateway fails → degraded, non-JSON → fallback |
| Prompt construction | 2 | All data in prompt, minimal profile handled |
| Observability spans | 6 | data.fetch, path.generate, prereq_violations, degraded span, ai_gateway sub-span, no-profile span |

---

## Dependencies

- **AI03 Gateway** (service binding) — called for LLM text generation
- **LMS REST API** (future) — learner profile, catalogue, progress
- No Vectorize, no D1, no KV needed — AI06 is stateless
