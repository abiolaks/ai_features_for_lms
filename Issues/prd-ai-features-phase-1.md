# PRD: AI Features for LMS — Phase 1 MVP

## Problem Statement

Learners on the LMS platform currently navigate static course catalogues, consume content without contextual help, and lack personalized guidance. Admins manually create assessments and rely on raw dashboards to understand learner progress. The platform offers no intelligence layer — no tailored paths, no in-lesson tutoring, no automated assessment generation, and no cross-platform assistance. This results in disengaged learners, high admin burden, and low platform stickiness.

## Solution

Introduce an AI layer that is **grounded in platform content only** (no general internet knowledge), **explainable** (every suggestion includes a rationale), and **respects learner agency** (AI assists, humans decide). Phase 1 delivers the core observable experience: onboarding with skill profiling, personalized learning paths, in-lesson grounded Q&A tutoring, course recommendations, post-quiz coaching insights, AI-generated assessments with mandatory admin approval, quality checks, and a persistent platform assistant. AI features degrade gracefully — core LMS functions (videos, quizzes, progress) remain fully operational when AI is unavailable.

## User Stories

### Onboarding & Profile (AI-01)

1. As a new learner, I want to select skills from a taxonomy and write free-text goals during onboarding, so that the platform understands my background without requiring a CV upload.
2. As a learner, I want to review and edit my extracted profile before saving, so that I can correct any inaccuracies.
3. As a learner, I want to update my skills, goals, role, and experience level at any time, so that my profile stays current as I grow.

### Personalized Learning Paths (AI-02)

4. As a learner with a rich profile, I want a tailored learning path with a "why this fits you" explanation per course, so that I understand the reasoning behind each recommendation.
5. As a learner with a minimal profile, I want to browse the course catalogue with a prompt to add more details, so that I am not shown a generic path pretending to be personalized.
6. As a learner with a partial profile, I want a starting-point path clearly labeled as "based on limited information," so that my expectations are set correctly.
7. As a learner, I want my learning path visually presented as a sequence with course titles, thumbnails, and estimated effort, so that I can plan my learning journey.

### Course & Catalogue Recommendations (AI-03)

8. As a learner, I want to see "Recommended for you" items on my dashboard with a one-sentence reason per recommendation, so that I discover relevant courses continuously.
9. As a learner, I want to see "Because you completed X…" suggestions in the catalogue sidebar, so that I find natural next steps after finishing a course.
10. As a learner, I want to see "What to take next" after completing a course, so that my learning journey continues seamlessly.
11. As a learner, I want recommendations to refresh on each dashboard visit (cached up to 24 hours), so that suggestions stay relevant.
12. As a learner, I want to see rule-based recommendations when AI is unavailable, so that the recommendation widget is never empty.

### In-Lesson Grounded Q&A Tutor (AI-04)

13. As a learner consuming a lesson, I want to ask questions about the lesson content and receive answers grounded in the material, so that I get contextual help without leaving the lesson.
14. As a learner, I want every tutor answer to include citations (lesson section, video timestamp), so that I can verify the source material myself.
15. As a learner, I want the tutor to default to lesson-only scope and offer to search the module when it cannot find an answer, so that I control how wide the search goes.
16. As a learner, I want my tutor conversation history retained for 30 days, so that I can refer back to previous answers during my learning.
17. As a learner, I want the ability to delete my conversation history at any time with a single action, so that I control my data.
18. As a learner, I want a visible notice that conversations are kept for 30 days, so that I understand the retention policy.

### Post-Activity Insights (AI-06)

19. As a learner who just completed a quiz, I want personalized feedback on my performance with an encouraging tone, so that I feel coached rather than judged.
20. As a learner who scored well, I want positive reinforcement highlighting what I mastered, so that I build confidence.
21. As a learner who scored poorly, I want specific links to review material for missed topics, so that I can improve efficiently.
22. As a learner, I want insights scoped to the single quiz I just took, so that feedback is immediate and actionable.

### Platform Assistant (AI-16)

23. As a learner, I want a persistent assistant available everywhere on the platform, so that I can ask about navigation and progress at any time.
24. As a learner, I want the assistant to answer questions like "How far am I in this course?" and "What's next?", so that I don't need to navigate menus.
25. As a learner, I want the assistant to hand off content questions to the Lesson Tutor when I'm inside a lesson, so that I get the right kind of help in the right place.

### Assessment Generation (AI-08)

26. As an admin, I want to generate quiz questions from a source lesson by specifying a count, so that I can create assessments quickly.
27. As an admin, I want to review generated questions side-by-side with the source excerpt they trace to, so that I can verify accuracy before publishing.
28. As an admin, I want to approve, reject, or edit each generated question individually, so that I have fine-grained control.
29. As an admin, I want to approve or reject all questions in a batch with a single action, so that I can process large sets efficiently.
30. As an admin, I want inline-edited questions flagged as "admin-modified" with a corresponding note on the source trace, so that the traceability chain is transparent.
31. As an admin, I want approved questions to show a staleness warning when their source lesson is updated, so that I can review and update them as needed.

### Quality & Alignment Checks (AI-09)

32. As an admin, I want duplicate questions flagged during the publish workflow, so that my assessment bank stays clean.
33. As an admin, I want reading level mismatches between questions and course difficulty flagged, so that assessments match the intended audience.
34. As an admin, I want quality checks to run as a gate before publishing, so that issues are caught before learners see them.
35. As an admin, I want to manually resolve flagged duplicates and mismatches, so that I retain final judgment over quality decisions.

### Cross-Cutting Governance

36. As an org admin, I want AI features to respect usage budgets with soft throttling at 80% and a hard stop at 100%, so that costs stay controlled.
37. As a learner whose org has exhausted its AI budget, I want a clear message directing me to my admin, so that I understand the situation and know who to contact.
38. As any user, I want AI features to degrade gracefully (amber banner, disabled button with tooltip, placeholder text) when AI is unavailable, so that the core platform remains fully functional.
39. As any user, I want a platform-wide status indicator when AI is degraded, so that I know it is a system issue and not a problem with my account.
40. As an org admin, I want my organization's data strictly isolated from other orgs, so that no data leakage occurs under any circumstance.

## Implementation Decisions

### Architecture

1. **Module decomposition:** 13 modules across two layers — 5 core infrastructure modules (Indexing, RAG, LLM Gateway, Multi-Tenant Middleware, Usage Budgeting) and 8 feature modules (Profile, Tutor, Copilot, Assessment, Paths, Recommendations, Insights, Assistant).

2. **Deep modules:** Content Indexing Service, RAG Retrieval Engine, and LLM Gateway are deep modules — complex internals exposed through simple interfaces. They are the backbone for all grounded features.

3. **Two-model LLM strategy:** A fast/cheap model serves Tutor and Assistant (latency-sensitive). A more capable model serves Assessment Generation and Analytics (quality-sensitive). The LLM Gateway abstracts model routing behind a simple tier parameter.

4. **Embedding strategy:** Content is chunked at ~512 tokens with overlap. Each chunk carries full metadata (org ID, course ID, lesson ID, section heading, video timestamp). Embeddings are stored in a vector database with metadata filtering for multi-tenant isolation.

5. **Post-hoc citation injection:** The RAG layer retrieves chunks with metadata. The LLM generates the answer. A post-processing step attaches citations — more reliable than relying on the model to include them correctly.

6. **Data products:** Four curated read-only views for AI consumption: Catalogue Snapshot, Learner Context, Content Corpus, and Mentor Directory (Phase 2). AI services never access source tables directly.

### Groundedness

7. **Configurable strictness per org.** Default is hard reject (no ungrounded answers). Phase 2 adds a permissive toggle per org. The RAG Retrieval Engine enforces this — if no chunks are retrieved, no answer is generated (strict) or a "not found in content" message is returned (permissive, future).

8. **Content scope:** Lesson Tutor defaults to lesson-only RAG scope with a "search wider across module?" affordance. Study Copilot defaults to module scope with visible scope selector (lesson/module/course).

### Multi-Tenant Security

9. **Logical partitioning.** Every chunk and retrieval query carries org ID metadata. Filtering is enforced at the API gateway middleware layer — not in individual feature code. A missing org filter is a prevented-by-design scenario.

10. **Data scoping:** Learner data access is strictly limited to the authenticated user's own data. Admin aggregate data access passes through separate, permissioned endpoints.

### Conversation History

11. **30-day rolling window.** Conversations older than 30 days are automatically purged. Learners can delete their history at any time with a visible button. Admin override is available with audit logging. Full wipe — no metadata retention for analytics in Phase 1. A visible notice in the UI states the retention policy.

### Usage Budgeting

12. **Tokens-per-month caps per org.** The LLM Gateway enforces soft throttling at 80% (responses may slow) and hard stop at 100% (learner sees admin-directed message). Phase 1 caps are set generously to collect real usage data.

### Onboarding & Profile

13. **Manual profile only in Phase 1.** No CV parsing. Learner selects skills from the platform's skill taxonomy and writes free-text goals (max 500 chars). Optional role/title and experience level dropdown (Beginner/Intermediate/Advanced). Learner reviews and edits before save. CV upload/parse deferred to Phase 2.

### Path Generation

14. **Tiered quality gating.** Minimal profile → catalogue browse view with prompt to add details (no generation). Partial profile → generated path with "based on limited info" label. Rich profile → full personalization with per-course explanations.

### Recommendations

15. **Degradation cascade.** AI-powered recommendations with 24-hour cache. When AI is unavailable: org-curated defaults → popular-in-org → platform-wide popular. Fallback recommendations are visually distinct from AI-powered ones. The widget is never empty.

### Tutor & Assistant Separation

16. **Separate surfaces.** Tutor is embedded in the lesson page (contextual). Assistant is a persistent floating UI element everywhere else. Handoff mechanism — Assistant can suggest the Tutor for content questions. Conversation histories are separate.

### Assessment Generation & Approval

17. **Per-question approval with batch actions.** Admin reviews generated questions side-by-side with source excerpts. Approve/reject/edit per question, or approve-all/reject-all as batch. Inline-edited questions are flagged "admin-modified" with a note on source traceability. Approved questions detect source lesson updates and show a staleness warning.

18. **Quality checks gate publishing.** Duplicate detection and reading level mismatch checks run when admin hits "Publish Assessment." Results are flagged for manual resolution — no auto-fix.

### Post-Activity Insights

19. **Quiz-only trigger.** Insights fire after every quiz attempt, regardless of score. High scorers get positive reinforcement. Low scorers get coaching with links to review material. Single-quiz context only — no cross-quiz pattern analysis (that is Admin Analytics territory, Phase 3).

### Fail Gracefully

20. **Degrade, don't remove.** Inline AI features (Tutor, Assessment Gen) show an amber dismissible banner with disabled triggers and tooltip. Enrichment features (Path explanations, Insights) replace AI sections with placeholder text. A platform-wide status indicator appears when AI is degraded.

### Content Indexing SLA

21. **Async indexing.** Publish/update triggers an async indexing job with a 5-minute freshness SLA. During the window, AI features show an "Indexing in progress" banner. Deletion triggers a high-priority queue processed within 60 seconds.

### Phasing

22. **Phase 1 exit criteria:** All P1 features deployed and passing integration tests. 2-3 pilot orgs, minimum 4-week run. Real usage data (token consumption, latency). Qualitative signals: learners voluntarily using the tutor, admins approving generated questions. No compliance blockers. AI-05 (Copilot), AI-10 (Mentor Matching), AI-11 (Skill-Gap), AI-12 (Org Plan Tuning), and AI-13 (Admin Analytics) are out of scope for Phase 1.

## Testing Decisions

### Testing Philosophy

Tests verify **external behavior only** — inputs, outputs, side effects. Implementation details (internal data structures, private methods, intermediate states) are not tested directly. Each module is tested in isolation via its public interface.

### Modules Under Test

All 13 modules are tested:

| Module | Test Focus |
|---|---|
| Content Indexing Service | Chunking correctness, metadata attachment, embedding generation, indexing/de-indexing lifecycle, SLA compliance |
| RAG Retrieval Engine | Scope enforcement (lesson/module/course), org isolation, citation format, empty-result handling |
| LLM Gateway | Model routing by tier, token counting, budget enforcement (80% throttle, 100% hard stop), provider error handling |
| Multi-Tenant Security Middleware | Org ID injection, cross-org access prevention, request validation |
| Usage Budgeting Service | Cap enforcement, throttle state transitions, reset on billing period |
| Learner Profile Service | CRUD operations, taxonomy validation, field constraints |
| Tutor Service | Grounded answer generation, citation format, scope expansion affordance, history retention/deletion |
| Study Copilot Service | Scope selector behavior, module default, dashboard-only access enforcement |
| Assessment Generation & Approval Service | Generation with source tracing, approval state machine transitions, dupe/reading-level checks, staleness detection |
| Path Generation Service | Tiered gating (minimal/partial/rich), explanation format |
| Recommendation Engine | AI-powered path, fallback cascade (curated → popular-in-org → platform-wide), cache behavior |
| Post-Activity Insight Service | Quiz-only trigger, tone variation by score, review link generation |
| Platform Assistant Service | Navigation/progress query handling, Tutor handoff behavior |

### Test Types

- **Unit tests:** Each module in isolation with mocked dependencies.
- **Integration tests:** Module chains (e.g., Tutor → RAG → Indexing, Assessment → RAG → LLM Gateway).
- **Contract tests:** LLM Gateway provider interface, RAG retrieval format, data product schemas.
- **Failure mode tests:** AI unavailability, budget exhaustion, index staleness, empty content.

## Out of Scope

- **AI-05 Study Copilot** — Phase 2 (scaffold only in Phase 1)
- **AI-10 Mentor Matching** — Phase 2
- **AI-11 Skill-Gap Analysis** — Phase 2, dependent on org skill framework existing
- **AI-12 Org Learning Plan Tuning** — Phase 3
- **AI-13 Admin Analytics Narratives** — Phase 3
- CV/Resume parsing — Phase 2 (manual profile only in Phase 1)
- Permissive groundedness mode — Phase 2 (hard reject only in Phase 1)
- Cross-quiz learner pattern analysis — Phase 3 (Admin Analytics territory)
- Admin batch mentor matching — Phase 3
- Physical multi-tenant isolation (dedicated deployments per org) — Phase 3 evaluation

## Further Notes

- The five non-negotiable design principles (Grounded, Explainable, Learner Agency, Human-in-the-Loop for Publishing, Fail Gracefully) are the acceptance criteria for every feature. No feature is complete if it violates any principle.
- The Content Indexing Service is the single most critical module — every grounded feature depends on it. Its SLA (5-min update, 60-sec delete) must be proven in production during Phase 1 pilot before Phase 2 begins.
- Conversation history is intentionally kept separate between Tutor and Assistant — they serve different purposes and consume different data products.
- The skill taxonomy used by the Learner Profile Service must exist as a platform capability before onboarding can go live. If it does not exist, it must be built as a prerequisite (simple tag-based taxonomy is sufficient for Phase 1).
- Usage budget caps are set generously for Phase 1 to avoid blocking pilot usage. Real caps will be calibrated from pilot data.
