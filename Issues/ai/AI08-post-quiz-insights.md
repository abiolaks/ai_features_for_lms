GitHub Issue: [#6](https://github.com/datazone-ai/ai_features_for_lms/issues/6)

# AI08: Post-Quiz Insights

- **Type:** AFK
- **Week:** 3
- **Blocked by:** AI03 (LLM Gateway), LMS `/api/v1/learner/assessments/{id}`, `/api/v1/progress/user`, `/api/v1/lessons/{id}`
- **PR target:** ~200 lines

## What to build

After a learner completes a quiz, generate a personalized coaching insight. Lowest-effort, highest-impact feature — all data already exists in LMS.

**One endpoint:**

`POST /insights/generate` — body: `{ assessment_id, learner_id, org_id }`
→ response: `{ insight_text, missed_topics: [{ topic, review_link }], tone_check: "encouraging" }`

**Behavior:**
1. Get assessment results: `GET /api/v1/learner/assessments/{assessment_id}`
   → Extract: score, correct/incorrect breakdown, per-question timing (`timeSpentSeconds`)
2. Get course progress: `GET /api/v1/progress/user`
   → Extract: course completion %, total time spent
3. Get lesson sections: `GET /api/v1/lessons/{lesson_id}`
   → Build review links: `/courses/{course_id}/lessons/{lesson_id}#{section_slug}`
4. Build insight prompt:
   ```
   Quiz results: score X%, N correct out of M.
   Time spent per question: { breakdown }
   Course progress: Y% complete.
   
   Generate a brief, encouraging insight. Rules:
   - Start with something positive, even if score is low.
   - Identify 1-2 topics to review based on missed questions.
   - If they spent significantly longer on a topic, mention it.
   - Reference their course progress positively.
   - NEVER use negative, shaming, or discouraging language.
   ```
5. Call AI03 (tier=standard) → parse response
6. Attach review links to missed topics from lesson sections

## Acceptance criteria

- [ ] Submit quiz → AI generates insight with topic-specific review links
- [ ] Insight references course progress ("you're 65% through — right on track")
- [ ] Insight references time-per-question ("you spent longer on loops — review suggested")
- [ ] Tone is encouraging for all scores (0%, 50%, 100%)
- [ ] All review links are valid LMS URLs pointing to specific sections
- [ ] AI03 unavailable → returns placeholder: "Insights unavailable right now"
- [ ] Unit tests: prompt construction, tone enforcement, review link generation
- [ ] **Observability:** Insight span includes score, question count, missed topics
- [ ] **Observability:** Review links validated (no 404s) — captured as span attribute
- [ ] **Observability:** Tone check flag (`tone.encouraging: true`) captured
