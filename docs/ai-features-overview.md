# AI Features Overview

> What each feature does and how the LMS uses it.

---

## Learner-Facing Features

### 1. Tutor — Grounded Q&A

**What it does:** Answers learner questions with citations from the exact lesson content. Learner types "What is a variable?" → gets answer with quotes from the video transcript. Scope expands from lesson → module → course if nothing found. Voice input/output supported (speak a question, hear the answer).

**Conversation state:** Remembers the last 20 messages per learner per course. Follow-ups like "give me an example" work because it remembers context.

**LMS integration:** Frontend. Embed a chat widget in the lesson view. Call `POST /tutor/ask` when the learner submits a question, `POST /tutor/clear` on logout or course change.

---

### 2. Assistant — Platform-Wide Chat

**What it does:** A chatbot that searches across all courses in the org. "What courses cover Python?" → returns answer with citations and suggested courses. "Which one is best for a beginner?" works because it remembers the conversation.

**Difference from Tutor:** Tutor is scoped to one lesson (deep). Assistant searches everything (broad). Tutor is for "help me understand this video." Assistant is for "what should I learn?"

**LMS integration:** Frontend. Floating chat button or dedicated page. Call `POST /assistant/ask` and `POST /assistant/clear`.

---

### 3. Learning Paths — Personalized Curriculum

**What it does:** Reads the learner's profile (skills, goals, completed courses), scans the course catalogue, and generates a personalized ordered learning path via LLM. "Learn Python Basics → Data Science 101 → ML Engineering."

**Degraded mode:** Returns a generic catalogue-based ordering if LLM is down.

**LMS integration:** Frontend. "My Learning Path" page. Call `POST /paths/generate`.

---

### 4. Recommendations — "For You" and "What's Next"

**What it does:** Two surfaces:

- **Dashboard recommendations** (`POST /recommendations/dashboard`): "For You" widget showing courses the learner should take, with AI explanations of why each one fits. Cached for 24h per learner.
- **Next steps** (`POST /recommendations/next`): After completing a course, shows what to take next. Prerequisite-aware — boosts courses that list the completed course as a prerequisite.

**Fallback:** If LLM is down, uses a content-similarity engine (Vectorize + course metadata) to generate recommendations without AI.

**LMS integration:** Frontend. Embed on dashboard and course completion screen.

---

### 5. Quiz Insights — Post-Quiz Coaching

**What it does:** After a learner submits a quiz, generates a personalized coaching insight. "You scored 60% (3/5). You're strong on variables but struggled with control flow." Includes links to relevant lessons for review.

**LMS integration:** Frontend. Call `POST /insights/generate` after quiz submission, show the insight on the results page.

---

### 6. Mentor — Skill-Gap Analysis + Session Prep

**What it does:** Two endpoints:

- **Skill-Gap** (`GET /mentor/skill-gap`): Compares learner's current skills against the course catalogue. Identifies gaps (e.g., "you're beginner at SQL but catalogue courses need intermediate") with estimated hours to close each gap.
- **Session Prep** (`POST /mentor/session-prep`): Generates a 3-topic agenda for a mentor 1-on-1. Analyzes stalled modules (<30% progress), lowest quiz topics, and learner goals. Returns agenda items with reasons and suggested durations.

**LMS integration:** Frontend. Skill-gap on learner dashboard, session prep before scheduled mentor calls.

---

## Content Authoring Features

### 7. Question Generation

**What it does:** Auto-generates quiz questions from lesson content. Instructor picks a lesson → worker fetches the content (via LMS API or Vectorize) → LLM generates 1–15 multiple-choice or true/false questions. Each question has difficulty level, topic tag, and correct answer.

**LMS integration:** Frontend. "Generate Quiz" button in the course authoring/admin panel. Instructor reviews and approves questions before publishing.

---

### 8. Quality Checks

**What it does:** Validates AI-generated quiz questions against source content. Checks accuracy (is the correct answer actually correct?), distractor quality (are wrong answers plausible but clearly wrong?), clarity, difficulty alignment, and bias. Returns pass/fail per question with specific suggestions.

**LMS integration:** Frontend. Run after question generation, before publishing. Shows a validation report — instructor can accept, edit, or regenerate flagged questions.

---

## Admin-Facing Features

### 9. Bottleneck Detection

**What it does:** Analyzes aggregate learner data to find where learners consistently stall. Surfaces modules with abnormally high completion times, prerequisite gaps, and quiz score drops. AI generates suggestions for each bottleneck.

**Example:** "Module 3 (Advanced Algorithms) takes 45 days median vs 14 expected — 78 learners stalled. Suggestion: Add a prerequisite review lesson on sorting algorithms."

**LMS integration:** Frontend. Admin dashboard. Call `GET /admin/bottlenecks?org_id=<uuid>&period=last_90_days`.

---

### 10. Engagement Monitoring

**What it does:** Tracks learner engagement patterns. Identifies videos with high drop-off rates, courses with high stall rates, peak/off-peak usage hours, and day-of-week patterns. AI generates retention suggestions.

**Example:** "3 videos have >50% drop-off at the 4-minute mark. Peak usage is Tuesday 10 AM. Suggestion: Send re-engagement emails on Monday evening for Tuesday morning sessions."

**LMS integration:** Frontend. Admin dashboard. Call `GET /admin/engagement?org_id=<uuid>&period=last_30_days`.

---

### 11. Analytics Narratives

**What it does:** Reads all aggregate admin data (progress, assessments, engagement) and generates a natural-language narrative comparing current vs previous period. Surfaces highlights (positive trends) and warnings (declining metrics) with raw numbers.

**Example:** "This month, completion rates improved +12% to 68%. Quiz scores are down -5% in the 'recursion' topic. 3 of 12 courses have stall rates above 30%."

**LMS integration:** Frontend. Admin dashboard overview. Call `GET /admin/narrative?org_id=<uuid>&period=last_30_days`.

---

## Backend-Only Features (No Frontend Widgets)

### 12. Content Indexing

**What it does:** Processes lesson content so the Tutor and Assistant can search it. When a lesson is published, the LMS fires a webhook → worker extracts text from the Cloudflare Stream video (VTT captions) or PDF/PPTX → chunks text → creates embeddings → stores in Vectorize. Runs async — returns `202` immediately.

**LMS integration:** Backend. Fire `POST /index` when content is published/updated, `POST /deindex` when content is removed.

---

### 13. LLM Gateway

**What it does:** Internal router that all other AI workers call (never called by LMS directly). Handles model selection (standard vs quality tier), token budgeting per org, and D1-based token usage tracking. Ensures no single worker can exhaust the token budget.

**LMS integration:** None — internal service binding only. But it depends on the `org_id` passed in every request to track per-org token usage.

---

## Quick Reference

| # | Feature | How LMS Uses It | Type |
|---|---------|-----------------|------|
| 1 | Tutor | Lesson page chat widget | Frontend |
| 2 | Assistant | Platform-wide chat | Frontend |
| 3 | Learning Paths | "My Path" page | Frontend |
| 4 | Recommendations | Dashboard + course completion | Frontend |
| 5 | Quiz Insights | Quiz results page | Frontend |
| 6 | Mentor | Dashboard + mentor sessions | Frontend |
| 7 | Question Gen | Course authoring panel | Frontend |
| 8 | Quality Checks | Question validation before publish | Frontend |
| 9 | Bottlenecks | Admin dashboard | Frontend |
| 10 | Engagement | Admin dashboard | Frontend |
| 11 | Narratives | Admin dashboard overview | Frontend |
| 12 | Content Indexing | Fire webhooks on content changes | Backend |
| 13 | LLM Gateway | Internal — no direct LMS integration | n/a |

For integration details (endpoints, request/response shapes, auth), see [`lms-integration-guide.md`](./lms-integration-guide.md).
