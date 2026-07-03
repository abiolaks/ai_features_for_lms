# Module Architecture — Phase 1 MVP

## Core Infrastructure (shared by all features)

| # | Module | Interface | What it encapsulates |
|---|---|---|---|
| 1 | **Content Indexing Service** | `index(content_event) → void`, `deindex(content_id) → void` | Extracts transcripts from Stream videos via REST API. Embeds content with `@cf/qwen/qwen3-embedding-0.6b` (1024-dim). Upserts directly to Vectorize index `lms-lessons` (cosine metric). No AI Search dependency — uses Workers AI + Vectorize bindings. Stores full metadata (title, lesson_id, course_id, org_id, transcript_source, content). Reacts to publish/update/delete events. |
| 2 | **RAG Retrieval Engine** | `retrieve(query, org_id, scope) → [chunk + citation]` | Vector similarity search via Vectorize with metadata filtering (org_id, lesson_id, course_id). Returns matched vectors with full metadata for citation generation. Used by AI04 Tutor. |
| 3 | **LLM Gateway** | `generate(prompt, tier, org_id) → response` | Provider abstraction, model routing (fast vs capable), token counting, org-level budget enforcement (soft throttle 80%, hard stop 100%). Single entry point for all LLM calls. |
| 4 | **Multi-Tenant Security Middleware** | `enforce_org_context(request) → org_id` | Intercepts AI requests, injects/validates org ID. Ensures row-level filtering. Gateway-level, not sprinkled across features. |
| 5 | **Usage Budgeting Service** | `check_budget(org_id, tokens) → allowed | denied` | Token-per-month caps per org. Throttle tracking. Used by LLM Gateway internally. |

## Feature Modules

| # | Module | Interface | What it encapsulates |
|---|---|---|---|
| 6 | **Learner Profile Service** | `get_profile(learner_id) → Profile`, `update_profile(…)` | Skills (from taxonomy), goals (free text), role, experience level. Simple CRUD. Feeds AI-02 and later AI-10. |
| 7 | **Tutor Service** | `ask(learner_id, lesson_id, question) → answer + citations` | Wraps RAG + LLM Gateway. Conversation history management (30-day rolling, learner-deleted). Scope expansion affordance. AI-04. |
| 8 | **Study Copilot Service** | `ask(learner_id, module_id, scope, question) → answer` | Dashboard/revision only. Module default scope. Visible scope selector. AI-05 (Phase 2, but scaffold now). |
| 9 | **Assessment Generation & Approval Service** | `generate(lesson_id, count) → questions`, `approve/reject/edit(…)` | Wraps RAG + LLM Gateway. Approval state machine. Side-by-side source tracing. Staleness detection. AI-08 + AI-09. |
| 10 | **Path Generation Service** | `generate_path(learner_id) → path + explanations` | Wraps LLM Gateway. Tiered quality gating (minimal → catalogue, partial → labeled, rich → full). AI-02. |
| 11 | **Recommendation Engine** | `recommend(learner_id, context) → [recommendation + reason]` | AI-powered + rule-based fallback cascade. 24hr cache. AI-03. |
| 12 | **Post-Activity Insight Service** | `generate_insight(learner_id, quiz_result) → insight` | Quiz-only trigger. Single-quiz context. Encouraging tone. Links to review material. AI-06. |
| 13 | **Platform Assistant Service** | `ask(learner_id, question) → answer` | Navigation/progress focus. Separate surface from Tutor. Handoff to Tutor for content questions. AI-16. |

## Data Products (read-only curated views for AI consumption)

| # | Data Product | Contents |
|---|---|---|
| DP-1 | Catalogue Snapshot | Courses, modules, tags, skills, prerequisites |
| DP-2 | Learner Context | Profile, enrollments, completions, scores |
| DP-3 | Content Corpus | Chunked text + embeddings per lesson version |
| DP-4 | Mentor Directory | Mentor profiles, specializations, availability (Phase 2) 0