# F04a: Bottleneck Detection

- **Type:** AFK
- **Phase:** 2
- **Depends on:** AI03 (LLM Gateway), LMS `/api/v1/progress/user` (aggregate), `/api/v1/learner/assessments` (aggregate)

## What to build

Analyze aggregate learner data across an org to identify where learners consistently stall. Surfaces modules with abnormally high completion times, prerequisite gaps, and quiz score drops — with AI-generated suggestions for curriculum improvements.

**Endpoint:**

`GET /admin/bottlenecks?org_id={org}&period=last_90_days`

**Behavior:**
1. Fetch aggregate progress + quiz data from LMS endpoints for the org
2. Compute: median completion time per module, quiz score trends, prerequisite pass rates
3. Flag modules where median time > 2× expected OR quiz scores < configurable benchmark
4. Build prompt:
   ```
   Org: {org_id}, Period: {period}, Learners: {count}
   Bottlenecks found: [{ module, metric, expected, actual, affected_learners }]
   
   For each bottleneck, generate: severity (high/medium/low),
   finding (one sentence), suggestion (actionable), rationale (with data).
   Return JSON array.
   ```
5. Call AI03 Gateway (standard tier)
6. Return ranked bottlenecks with suggestions

## Data aggregation rules

- Minimum cohort: 10 learners (suppress noise from tiny samples)
- Time window: configurable, default 90 days
- No individual learner identifiable — minimum aggregation unit is 5
- Org-scoped only

## Acceptance criteria

- [ ] Identifies modules where median completion >2× expected time
- [ ] Identifies topics where quiz scores below configurable benchmark
- [ ] Each bottleneck includes: severity, finding, suggestion, rationale, affected count
- [ ] No insights when cohort <10 learners (returns "insufficient data" message)
- [ ] No individual learner data exposed in any response
- [ ] Calls AI03 for natural-language findings + suggestions
- [ ] Unit tests: bottleneck math, threshold logic, anonymity enforcement
- [ ] Observability: data fetch, computation, gateway call spans
