# AI Engineer — End Process

## What comes in (from the platform team)

| Input | Trigger | What it carries |
|---|---|---|
| **Content publish/update/delete events** | Admin publishes, updates, or removes a lesson/course | Content ID, org ID, lesson/module/course metadata, pointer to raw content in Blob Storage |
| **Raw content** | Available whenever content exists in Blob Storage | Plain text or structured text per lesson (transcripts, lesson body text) |
| **Four Data Products** | Always available, read-only | Curated views: Content Corpus (indexed chunks), Catalogue Snapshot (course catalogue), Learner Profile (skills/goals/history), Learner Context (current progress/enrollments) |
| **Authenticated user context** | Every user request | Org ID, learner ID — injected by the platform's multi-tenant middleware |
| **Quiz results** | Learner completes a quiz | Score, per-question results, lesson/course context |
| **Org budget config** | Set once by admin, updated as needed | Token cap per month per org |
| **Skill taxonomy** | Available at startup from platform | List of valid skill tags for profile validation. If not available at build time, ship a static taxonomy file as fallback (platform can replace later). |

## What the AI layer does

> **Note on ownership:** The deliverables doc lists "Learner Profile CRUD and storage" as platform-owned. However, the vertical slices and quick-wins plan assign Slice 5 (Learner Profile Service) to the AI engineer because Path Generation and Recommendations depend on it. This is non-AI plumbing — a thin CRUD service with no LLM or embeddings — but it lives in the AI engineer's lane until clarified otherwise.

### 1. Learner Profile Service

CRUD service with no AI dependency. Fields: skills (tag list, validated against platform skill taxonomy), goals (free text, max 500 chars), role/title (optional free text), experience level (dropdown: Beginner / Intermediate / Advanced). Four endpoints: create, read, update, delete. Exists purely to feed Path Generation and Recommendations with learner data. No CV parsing in Phase 1.

### 2. Indexing

When content is published/updated: chunk it into ~500-token pieces with overlap, embed each chunk, store in the search index with full metadata (org, course, lesson, section, timestamp). When content is deleted: remove all its chunks within 60 seconds. Failures don't block publishing — they retry asynchronously.

### 3. Retrieval

When any feature needs content: take the user's query, enforce org isolation (only that org's chunks), enforce scope boundaries (lesson-only, module-wide, or course-wide), return the most semantically relevant chunks with citations attached. If nothing relevant exists, return empty — never hallucinate.

### 4. Gateway & Budgeting

Every LLM call goes through one gate. Route to fast/cheap model for routine calls (Tutor, Assistant), capable model for quality-sensitive calls (Assessment Gen). Track tokens per org. At 80% of monthly cap, include a warning in the response. At 100%, reject and tell the user to contact their admin. Counters reset on billing boundary.

### 5. Tutoring

When a learner asks a question inside a lesson: retrieve relevant chunks from that lesson, generate a grounded answer with inline citations (lesson section, video timestamp). If no answer in the lesson, offer to expand to module scope. Keep conversation history for 30 days; delete on learner request.

### 6. Path Generation

When a learner views their learning path: take their profile (skills, goals, experience) from the Learner Profile Service and the course catalogue. If the profile is rich, generate a tailored course sequence with a "why this fits you" explanation per course. If the profile is minimal, say so honestly and suggest the learner add more detail. If the profile is partial, label the path "based on limited information."

### 7. Recommendations

When a learner visits their dashboard: generate "Recommended for you" items with one-sentence reasons. Also suggest "Because you completed X…" next steps in the sidebar. Cache results for 24 hours. If AI is down, fall back to rule-based recommendations (admin-curated defaults).

### 8. Post-Quiz Insights

When a learner finishes a quiz: generate encouraging, coach-like feedback. High scores get positive reinforcement highlighting what was mastered. Low scores get specific links to review material for missed topics, without judgmental language.

### 9. Assessment Generation

When an admin requests N questions from a source lesson: generate questions with source traces (excerpt from the lesson that inspired each). Push to an admin review panel. Admins approve, reject, or edit each question individually. Run quality checks: flag duplicates, verify reading level matches the course difficulty, detect staleness.

### 10. Platform Assistant

When a learner uses the persistent assistant anywhere on the platform: route the intent. Navigation/progress questions ("How far am I?", "What's next?") are answered directly from learner data. Content questions inside a lesson are handed off to the Tutor with a scope handoff.

## What comes out (to the platform team's UI)

| Output | Appears in | Content |
|---|---|---|
| **Learner profile CRUD** | Internal (consumed by Path Gen, Recs) | Skills, goals, role, experience level |
| **Tutor answer + citations** | Lesson page chat widget | Text response with inline citation references |
| **Learning path + explanations** | Dashboard | Ordered course list with per-course rationale |
| **Recommendations + reasons** | Dashboard, sidebar | Top-N items with one-sentence reason each |
| **Post-quiz insight + review links** | Quiz results page | Encouraging text + links to lesson sections to review |
| **Generated assessment questions + source traces** | Admin review panel | Questions with source excerpt and metadata (difficulty, duplicates flagged) |
| **Quality check results** | Admin publish gate | Flagged duplicates, reading level mismatches |
| **Platform assistant response** | Persistent assistant widget | Navigation answer or Tutor handoff |

## What the AI engineer does NOT own

The platform team is responsible for everything the AI layer touches but doesn't build: multi-tenant auth, the four data products (Content Corpus, Catalogue Snapshot, Learner Profile data product, Learner Context), skill taxonomy definition, course/module/lesson data model, quiz engine, all UI rendering, content authoring workflows, and the event bus that triggers indexing.

> **Exception:** The Learner Profile Service (Slice 5) is assigned to the AI engineer as non-AI plumbing to unblock Path Generation and Recommendations, despite the deliverables doc listing profile CRUD as platform-owned. Clarify with the team whether this stays in the AI lane or moves to platform. The platform still owns the underlying Learner Profile *data product* (the read-only curated view).
