
# Future: F05 — Admin Analytics Narratives

- **Phase:** 3
- **Requirements covered:** AI-13 (Admin Analytics Narratives)
- **Depends on:** P07 (Enrollment & Progress), P08 (Quiz Engine), F04 (Org Plan Tuning)

## What to build

Surface the "story" inside raw dashboard numbers for non-technical admins. Instead of charts and tables, admins get a natural language summary of what's happening in their organization — who's engaged, where learners struggle, what's working.

### Endpoint

```
GET /admin/narrative?org_id={org}&period=last_30_days

→ {
    summary: "Your org had a strong month. 85% of active learners made measurable progress, up from 72% last month. The new 'Python Basics' supplementary materials are working — quiz scores on Functions jumped from 67% to 81%. However, learner engagement drops noticeably on Fridays — consider scheduling live sessions earlier in the week.",
    highlights: [
      {
        sentiment: "positive",
        finding: "Quiz scores on Functions topic improved 14 percentage points",
        evidence: "67% → 81% across 45 learners in last 30 days",
        likely_cause: "Supplementary exercise set added on June 1"
      },
      {
        sentiment: "warning",
        finding: "Course completion rate trending down",
        evidence: "Down 8% month-over-month. 12 learners stalled at Module 4.",
        likely_cause: "Module 4 content length may be a factor — median completion time is 2 weeks vs 1 week expected"
      }
    ],
    metrics: {
      active_learners: 85,
      avg_progress_pct: 62,
      courses_completed: 12,
      avg_quiz_score: 74,
      engagement_trend: "up"
    },
    generated_at: "..."
  }
```

### Narrative generation

1. Fetch aggregate metrics from P07 and P08 (same aggregation rules as F04)
2. Compare to previous period (month-over-month or week-over-week)
3. Call Slice 3 (tier=quality) with a structured prompt:
   - "You are an analytics narrator. Summarize these metrics in 3-5 sentences for a non-technical admin. Highlight what changed, what's working, and what needs attention. Be encouraging but honest. Never identify individual learners."
4. Return narrative + supporting evidence + raw metrics

### What it covers

| Dimension | What the narrative highlights |
|-----------|------------------------------|
| **Engagement** | Active learners trend, session frequency, time-of-day patterns |
| **Progress** | Completion rates, stalled learners, fastest/slowest modules |
| **Performance** | Quiz score trends, topic strengths/weaknesses, benchmark comparisons |
| **Content** | Most/least popular courses, content gaps, suggested additions |
| **Comparisons** | Month-over-month, quarter-over-quarter, vs org benchmarks |

### Aggregation rules (same as F04)

- Minimum cohort: 10 learners
- No individual learner identifiable
- Org-scoped only
- Time window configurable (default 30 days)

## Acceptance criteria

- [ ] Narrative summarizes metrics in 3-5 natural language sentences
- [ ] Highlights categorized by sentiment (positive/warning/neutral)
- [ ] Each highlight includes finding, evidence, and likely cause
- [ ] Month-over-month comparisons included when previous period data exists
- [ ] No individual learner identifiable in narrative or evidence
- [ ] Empty org (<10 learners) → returns friendly message: "Not enough data yet for meaningful insights. Check back when more learners are active."
- [ ] Narrative tone is encouraging but honest — celebrates wins, flags concerns without alarm
- [ ] Raw metrics always included alongside narrative (for admins who want numbers)
- [ ] Unit tests: period comparison math, narrative generation, anonymity enforcement
- [ ] Integration tests: seed data for two periods → verify narrative captures trends correctly

## Blocked by

- P07 — enrollment and progress aggregate data
- P08 — quiz result aggregates
- F04 — plan tuning provides bottleneck/skill-gap context that enriches the narrative
