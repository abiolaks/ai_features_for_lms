
# Future: F04 — Org Learning Plan Tuning

- **Phase:** 3
- **Requirements covered:** AI-12 (Org Learning Plan Tuning)
- **Depends on:** AI06 (Personalized Learning Paths), P07 (Enrollment & Progress), P08 (Quiz Engine)

## What to build

Analyze aggregate learner data across an organization to suggest improvements to learning plans. Identifies patterns like "learners consistently stall at Module 4" or "quiz scores drop after Module 3" and recommends plan adjustments. All suggestions require admin approval.

### Endpoint

```
POST /admin/plan-tuning?org_id={org}

→ {
    insights: [
      {
        type: "bottleneck",
        severity: "high",
        finding: "62% of learners take >2 weeks to complete Module 4 (expected: 1 week)",
        affected_learners: 45,
        suggestion: "Add prerequisite lesson on 'Data Structures' before Module 4, or split Module 4 into smaller chunks.",
        rationale: "Quiz scores on Module 4 prerequisites average 58% — learners are entering unprepared."
      },
      {
        type: "skill-gap",
        severity: "medium",
        finding: "Learners completing 'Python Basics' score below org benchmark on 'Functions' topic",
        affected_learners: 78,
        suggestion: "Add supplementary exercise set for Functions topic.",
        rationale: "Benchmark is 80%, current average is 67% across last 3 cohorts."
      },
      {
        type: "engagement",
        severity: "low",
        finding: "Video completion rate drops 40% after 15-minute mark",
        affected_learners: 120,
        suggestion: "Split videos longer than 15 minutes into shorter segments.",
        rationale: "Engagement data shows sharp drop-off at 15:00 across all course videos."
      }
    ],
    generated_at: "...",
    status: "pending_admin_review"
  }
```

### Admin workflow

1. Admin triggers plan tuning analysis
2. System runs aggregation queries across all learners in org (no individual learner data exposed)
3. Calls Slice 3 (tier=quality) to generate insight narratives and suggestions
4. Returns suggestions with severity ratings and affected learner counts
5. Admin reviews and approves/rejects each suggestion
6. Approved suggestions are stored for the org's curriculum team to implement

### Data aggregation rules

- **Minimum cohort size:** 10 learners (don't surface insights from tiny samples)
- **Time window:** Last 90 days by default, configurable
- **Anonymity:** No individual learner is identified. Minimum aggregation unit is 5 learners.
- **Org isolation:** Only data from the requesting org is analyzed

### Approval state machine

```
pending_admin_review → approved | rejected
```

Same pattern as AI10b (Assessment Approval). No auto-apply — humans decide.

## Acceptance criteria

- [ ] Analysis returns insights only when cohort ≥10 learners (suppresses noise)
- [ ] Each insight includes: type, severity, finding, suggestion, rationale, affected count
- [ ] No individual learner identifiable in any insight
- [ ] Insights are org-scoped (cross-org aggregation prevented)
- [ ] Bottleneck detection: identifies modules where median completion time exceeds expected time by 2x
- [ ] Skill-gap detection: identifies topics where org average quiz score is below configurable benchmark
- [ ] Engagement detection: identifies content types where completion rate drops significantly
- [ ] Admin can approve or reject each insight individually
- [ ] Empty org (<10 learners) → returns message: "Insufficient data for meaningful insights"
- [ ] Unit tests: bottleneck math, anomaly detection thresholds, anonymity enforcement
- [ ] Integration tests: seed test data → run analysis → verify insights match expected patterns

## Blocked by

- AI06 — needs learning path structure for plan context
- P07 — needs enrollment and progress data across org
- P08 — needs quiz results aggregated across org
