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
1. Get assessment results: `GET /api/v1/learner/assessments/attempts/{attempt_id}`
   → Extract: score, correct/incorrect breakdown, per-question timing (`timeSpentSeconds`)
2. Get assessment metadata: `GET /api/v1/learner/assessments/{assessment_id}`
   → Extract: `moduleId`, `courseId` (api.json: Assessment has both)
3. Get course progress: `GET /api/v1/progress/user`
   → Extract: course completion %, total time spent
4. Get module lessons: `GET /api/v1/modules/{moduleId}/lessons` (api.json: no `success` wrapper)
   → Build candidate list of `{ id, title, sortOrder }` for topic matching
5. Match missed-question topics to lesson titles via keyword overlap
   → Review links: `/courses/{course_id}/lessons/{lesson_id}` — lesson-level only
   → No section anchors: LessonResource has no `sections` field (deferred until LMS adds them)
6. Build insight prompt:
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
- [ ] All review links are valid LMS URLs sourced from module listing (valid by construction)
- [ ] Section anchors deferred — LessonResource has no `sections` field
- [ ] AI03 unavailable → returns placeholder: "Insights unavailable right now"
- [ ] Unit tests: prompt construction, tone enforcement, review link generation
- [ ] **Observability:** Insight span includes score, question count, missed topics
- [ ] **Observability:** Review links validated (no 404s) — captured as span attribute
- [ ] **Observability:** Tone check flag (`tone.encouraging: true`) captured
