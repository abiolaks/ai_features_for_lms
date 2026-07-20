# F04b: Engagement Monitoring

- **Type:** AFK
- **Phase:** 2
- **Depends on:** AI03 (LLM Gateway), LMS `/api/v1/progress/user` (aggregate)

## What to build

Monitor learner engagement patterns across an org. Identifies drop-offs (videos abandoned, courses stalled), time-of-day patterns, and content consumption trends — with AI-generated suggestions to improve retention.

**Endpoint:**

`GET /admin/engagement?org_id={org}&period=last_30_days`

**Behavior:**
1. Fetch aggregate engagement data from LMS (completion rates, time-on-platform, video watch rates)
2. Compute: video completion drop-off points, module stall rates, daily/weekly activity patterns
3. Build prompt:
   ```
   Org: {org_id}, Period: {period}, Active learners: {count}
   Engagement data: {video_rates, completion_rates, activity_patterns}
   
   Identify engagement trends. Highlight what's working and what needs attention.
   Return JSON: [{ type, severity, finding, suggestion, affected_learners,
   evidence }]
   ```
4. Call AI03 Gateway (standard tier)
5. Return engagement insights

## Response shape

```json
{
  "insights": [
    {
      "type": "content_length",
      "severity": "high",
      "finding": "Video completion drops 40% after 15 minutes",
      "suggestion": "Split videos longer than 15 min into shorter segments",
      "affected_learners": 120,
      "evidence": "Engagement shows sharp drop-off at 15:00 across all course videos"
    }
  ],
  "generated_at": "..."
}
```

## Acceptance criteria

- [ ] Identifies video drop-off points (completion rate <60%)
- [ ] Identifies time-of-day/week patterns (low engagement periods)
- [ ] Each insight includes type, severity, finding, suggestion, evidence
- [ ] No insights when cohort <10 learners
- [ ] Calls AI03 for natural-language findings
- [ ] Unit tests: drop-off detection, pattern analysis, threshold logic
- [ ] Observability: data fetch, computation, gateway call spans
