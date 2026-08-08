# Part 8: Worker-Specific Patterns

Quick reference for each of the 10 remaining workers (non-gateway, non-indexing, non-tutor, non-assistant).

## ai-paths — Learning Path Generation

**Endpoint:** `POST /paths/generate { learner_id, org_id }`

**Flow:**
```
1. Fetch learner profile from LMS → skills, goals, experience_level
2. Fetch catalogue from LMS → all available courses
3. Fetch progress from LMS → exclude completed courses
4. Build prompt: [profile] + [catalogue: remaining courses] + [progress]
5. Call gateway (standard tier)
6. Parse JSON response → { title, description, milestones: [{ course_title, rationale, order }] }
7. Return structured learning path
```

**Degraded:** Empty profile → "Add skills to your profile." Gateway down → keyword-matched path from catalogue.

## ai-recommendations — Dashboard + Next-Course Recommendations

**Endpoints:**
- `GET /recommendations/dashboard?learner_id=&org_id=`
- `GET /recommendations/next?learner_id=&org_id=`
- `POST /recommendations/dashboard` (same body-based variant)

**Flow:**
```
1. Fetch profile + catalogue + progress from LMS
2. Build prompt with profile + catalogue + progress
3. Call gateway (standard tier)
4. Parse recommendations: [{ course_title, reason, score }]
5. Cache in KV (24h TTL, keyed by learner_id + org_id)
6. Return recommendations

Fallback engine (when gateway down):
  - Content similarity: embed profile skills, query Vectorize for similar content
  - Map content matches back to courses
  - Sort by match count
```

**KV cache:** Avoids expensive LMS fetches + LLM calls on every page load. Dashboard loads in ~50ms from cache vs ~3s uncached.

## ai-insights — Post-Quiz Coaching + Session Prep

**Endpoints:**
- `POST /insights/generate { learner_id, quiz_id, org_id }`
- `POST /insights/mentor/session-prep { learner_id, mentor_id, org_id }`

**Quiz insights flow:**
```
1. Fetch quiz attempt from LMS (answers, scores)
2. Fetch lesson content for wrong answers
3. Build prompt: [quiz results] + [wrong answers] + [lesson content]
4. Call gateway (standard tier)
5. Parse: { strengths[], weaknesses[], review_links[], summary }
6. Return insights with links to lessons for wrong answers
```

**Session prep flow:**
```
1. Fetch profile + progress + assessment summary from LMS
2. Identify: stalled modules (<30% progress), lowest quiz topics
3. Build prompt with progress + quiz data
4. Call gateway → 3-topic agenda prioritized by urgency
5. Return { recent_activity, suggested_agenda, prep_materials }
```

## ai-mentor — Skill-Gap Analysis

**Endpoint:** `GET /mentor/skill-gap?learner_id=&org_id=`

**Flow:**
```
1. Fetch profile → learner's skills + goals
2. Fetch catalogue → course prerequisites + difficulty
3. Fetch progress → exclude completed courses
4. Map: learner_skills vs course_requirements → gap matrix
5. Call gateway (standard tier) → structured gap analysis
6. Return { gaps: [{ skill, required_for[], courses_available[], estimated_hours }], summary }
```

**Degraded:** Empty profile → "Add skills to your profile." Gateway down → keyword-based skill matching.

## ai-bottlenecks — Admin Bottleneck Detection

**Endpoint:** `GET /admin/bottlenecks?org_id=&period=last_90_days`

**Flow:**
```
1. Fetch progress/aggregate from LMS → per-module completion stats
2. Fetch assessments/aggregate from LMS → per-topic quiz scores
3. Identify: high median_completion_days vs expected, low pass rates
4. Call gateway (standard tier) → bottleneck narrative + severity
5. Return { bottlenecks: [{ module, completion_days, pass_rate, severity, narrative }], summary, period }
```

**Privacy:** <10 learners in cohort → empty results. <5 in any stat → null.

## ai-engagement — Admin Engagement Monitoring

**Endpoint:** `GET /admin/engagement?org_id=&period=last_30_days`

**Flow:**
```
1. Fetch admin/engagement from LMS → video completion, drop-off, stall rates, activity
2. Identify: low-completion videos, stalled modules, off-peak patterns
3. Call gateway (standard tier) → engagement insights + recommendations
4. Return { video_completion, drop_off_videos, course_stalls, activity_patterns, summary }
```

## ai-analytics — Admin Analytics Narratives

**Endpoint:** `GET /admin/narrative?org_id=&period=`

**Flow:**
```
1. Fetch progress/aggregate + assessments/aggregate + engagement from LMS
2. Build data-rich prompt with all aggregate metrics
3. Call gateway (QUALITY tier → llama-3.3-70b) ← THE ONLY CONSUMER
4. Return { overall_summary, highlights[], concerns[], recommendations[], period_comparison }
```

**Why quality tier?** Natural language summaries need better quality than structured Q&A. 70B model produces more nuanced, professional narratives.

## ai-question-gen — Quiz Question Generation

**Endpoint:** `POST /questions/generate { lesson_id, question_count, types[], difficulty, org_id }`

**Flow:**
```
1. Fetch lesson content from LMS
2. Embed + query Vectorize for relevant content chunks
3. Build prompt: [content] + [question types] + [difficulty]
4. Call gateway (QUALITY tier → llama-3.3-70b)
5. Parse: { questions: [{ type, question, options[], correct_answer, explanation }] }
6. Return questions + metadata
```

**Question types:** multiple_choice, true_false, short_answer.

**Why quality tier?** Generating plausible wrong answers + accurate explanations requires strong reasoning. 3B model often produces illogical distractors.

## ai-quality — Question Validation

**Endpoint:** `POST /questions/validate { questions[], org_id }`

**Flow:**
```
1. For each question, validate:
   - Accuracy: correct answer matches content
   - Bias: no demographic/cultural assumptions
   - Clarity: unambiguous wording, grade-level appropriate
   - Distractors: plausible wrong answers
2. Call gateway (standard tier) for validation ← NO LMS calls needed
3. Return { results: [{ question_index, accuracy_score, bias_flags[], clarity_score, distractor_score }], overall_score, issues[] }
```
