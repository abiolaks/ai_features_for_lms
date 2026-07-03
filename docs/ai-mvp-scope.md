# AI MVP — What We Actually Need to Build

> Given the LMS already has profiles, gamification, assessments, recommendations, skill gaps, streaks, and progress tracking — the AI layer should add what the LMS **cannot** do on its own.

---

## The LMS vs AI Layer Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    LMS (ALREADY BUILT)                    │
│                                                          │
│  ✅ Course catalog + search       ✅ Learner profiles    │
│  ✅ Lesson content storage        ✅ Gamification        │
│  ✅ Progress tracking             ✅ Assessment engine   │
│  ✅ Basic recommendations         ✅ Skill gap analysis  │
│  ✅ Activity streaks              ✅ Admin dashboard     │
│  ✅ Auth + Gateway                ✅ Health endpoint     │
│                                                          │
│  ❌ Can't answer questions about lesson content          │
│  ❌ Can't generate personalized coaching insights        │
│  ❌ Can't explain WHY a course fits this learner         │
│  ❌ Can't auto-generate quiz questions from lessons      │
│  ❌ Can't have a natural-language conversation about LMS │
└─────────────────────────────────────────────────────────┘
                         │
                         │  AI Workers READ from LMS API
                         │  AI Workers WRITE nothing to LMS
                         ▼
┌─────────────────────────────────────────────────────────┐
│                 AI Layer (MVP — TO BUILD)                 │
│                                                          │
│  ✅ AI03 LLM Gateway      ← 1 Worker, calls Workers AI  │
│  ✅ AI01 Indexing         ← chunk + embed + index        │
│  ✅ AI02 RAG Retrieval    ← vector search               │
│  ✅ AI04a Tutor           ← grounded Q&A with citations  │
│  ✅ AI08 Post-Quiz Insights ← coaching from quiz results │
│  ✅ AI06 Learning Paths   ← AI-personalized paths        │
│  ✅ AI07 Enhanced Recs    ← AI "why this fits" reasons    │
│                                                          │
│  🔶 AI09 Platform Asst    ← stretch goal                 │
│  ❌ AI05 Profile  → CUT   (LMS handles this)            │
│  ❌ AI10a Question Gen    (post-MVP)                    │
│  ❌ AI10b Approval        (post-MVP, use LMS admin)     │
│  ❌ AI11 Quality Checks   (post-MVP)                    │
└─────────────────────────────────────────────────────────┘
```

---

## MVP Scope: 7 Workers, 3 Phases

### Phase 1: Foundation (Week 1-2) — The Data Pipeline

**What:** Index lesson content so AI can search it.

| Worker | What it does | LMS endpoint used |
|--------|-------------|-------------------|
| **AI03** LLM Gateway | Calls Workers AI. Budget tracking in D1. | None (D1 for budget) |
| **AI01a** Chunking | Reads lesson content, splits into ~512-token chunks | `GET /v1/lessons/{id}` |
| **AI01b** Indexing | Embeds chunks (bge-m3), stores in Vectorize | `GET /v1/modules/{id}/lessons` |
| **AI02** RAG Retrieval | Embeds query, searches Vectorize, returns relevant chunks | None (Vectorize only) |

**Done when:** Index a real lesson → query it → get relevant chunks back.

---

### Phase 2: Core AI Features (Week 3-4) — What Learners Actually See

**What:** Three AI features that the LMS clearly cannot do today.

#### MVP Feature 1: AI04a Tutor — "Ask the Lesson Anything"

```
Learner: "What's the difference between a list and a tuple?"
Tutor:   "A list is mutable (can be modified after creation) while a tuple
          is immutable. [Python Basics > Data Structures > 3:22]
          Lists use square brackets [], tuples use parentheses ()."
```

| Step | Action | LMS/CF call |
|------|--------|-------------|
| 1 | Get lesson content for context | `GET /v1/lessons/{lessonId}` |
| 2 | Embed question → search Vectorize | AI02 (Vectorize) |
| 3 | Build grounded prompt with chunks | — |
| 4 | Generate answer via AI03 | AI03 (Workers AI Llama 3.2) |
| 5 | Return answer + citations | — |

**Why this is MVP:** The LMS stores content but can't answer questions about it. This is the #1 AI feature learners expect.

**Effort:** Medium. Depends on AI02 + AI03 (both built in Phase 1).

#### MVP Feature 2: AI08 Post-Quiz Insights — "What Your Score Means"

```
Learner finishes quiz → AI generates:

"You scored 75% (9/12). Strong performance on functions (3/3),
but missed 2/3 questions on error handling.
⏱️ You spent 4x longer on error-handling questions — this
   suggests the topic needs review.
📖 Review: Error Handling in Python [Python Basics > Exceptions > 5:10]
💪 You're at 65% course completion — right on track!"
```

| Step | Action | LMS/CF call |
|------|--------|-------------|
| 1 | Get assessment results | `GET /v1/learner/assessments/{id}` |
| 2 | Get course progress for context | `GET /v1/progress/user` |
| 3 | Get lesson structure for review links | `GET /v1/lessons/{lessonId}` |
| 4 | Build insight prompt | — |
| 5 | Generate via AI03 | AI03 (Workers AI Llama 3.2) |

**Why this is MVP:** All the data already exists in LMS. We just need to read it and generate text. Lowest-effort, high-impact feature.

**Effort:** Low. LMS stores everything — we just prompt-engineer.

#### MVP Feature 3: AI06 Learning Paths — "Your AI-Personalized Curriculum"

```
Learner: "Generate my learning path"
AI:      "Based on your profile (Python beginner, 5-day streak,
          completed 'Intro to Programming'):

          1. Python Fundamentals — Build on your intro knowledge
             [12 lessons, ~6 hours]

          2. Data Structures in Python — Your org has a skill gap here
             [8 lessons, ~4 hours]

          3. Web Scraping with Python — Matches your 'automation' goal
             [10 lessons, ~5 hours]"
```

| Step | Action | LMS/CF call |
|------|--------|-------------|
| 1 | Get learner profile (skills, gamification, stats) | `GET /v1/learner/profile` |
| 2 | Get course catalogue | `GET /v1/catalog` |
| 3 | Get current progress | `GET /v1/progress/user` |
| 4 | Get org skill gaps | `GET /v1/analytics/dashboard/skill-gaps` |
| 5 | Generate path via AI03 | AI03 (Workers AI Llama 3.2) |

**Why this is MVP:** LMS has catalogue + profile but can't generate personalized paths with reasons. The rich LMS data (gamification, streaks, skill gaps) makes the AI output better than any static path.

**Effort:** Medium. All data exists in LMS — just needs prompt engineering.

---

### Phase 3: Enhancement (Week 5) — Make It Smarter

#### AI07 Enhanced Recommendations — "Why You Should Take This"

```
LMS already says: "Recommended: Advanced Python"
AI adds:          "This fits because you've mastered all prerequisites
                  and it addresses the 'decorators' skill gap identified
                  in your last assessment. 85% of learners with your
                  profile who took this course completed it."
```

| Step | Action | LMS/CF call |
|------|--------|-------------|
| 1 | Get LMS baseline recommendations | `GET /v1/courses/recommendations` |
| 2 | Get learner profile + progress | `GET /v1/learner/profile`, `/v1/progress/user` |
| 3 | Generate AI "why this fits" explanations | AI03 (Workers AI Llama 3.2) |
| 4 | Merge LMS recs with AI reasons | — |

**Effort:** Low. LMS already does recommendations — we just add explanations.

---

## What We Explicitly CUT from MVP

| Feature | Why cut | When |
|---------|---------|------|
| **AI05 Learner Profile** | LMS already has richer profiles (gamification, streaks, stats) | Never — use LMS |
| **AI10a Question Generation** | Complex prompt engineering, quality tier LLM needed, approval workflow dependency | Post-MVP |
| **AI10b Approval Workflow** | LMS already has admin dashboard + assessment management | Post-MVP (integrate with LMS admin) |
| **AI11 Quality Checks** | Adds value but no learner-visible impact | Post-MVP |
| **AI04b Tutor History** | Start with stateless Q&A. History can be added later as Durable Object. | Post-MVP |
| **AI09 Platform Assistant** | Requires conversation management + multiple LMS endpoints. Stretch goal. | Stretch / Post-MVP |
| **AI12 Fail Gracefully** | Each Worker handles its own errors. Dedicated Worker not needed for MVP. | Implicit in each Worker |

---

## MVP Architecture — 7 Workers

```
                    Learner Browser
                         │
          ┌──────────────┼──────────────┐
          │              │              │
     LMS Gateway    AI Workers      AI Workers
     (existing)     (user-facing)   (internal)
          │              │              │
          │         AI04a Tutor    AI03 Gateway
          │         AI06 Paths     AI01a Chunk
          │         AI07 Recs      AI01b Index
          │         AI08 Insights  AI02 Retrieval
          │              │              │
          ▼              ▼              ▼
     ┌────────┐    ┌──────────┐   ┌──────────┐
     │  LMS   │    │ Workers AI │   │ CF Infra │
     │  API   │    │ Llama/Mistral│  │ Vectorize│
     │ (data) │    │ (LLM)    │   │ D1, KV   │
     └────────┘    └──────────┘   └──────────┘
```

---

## Build Order (5 weeks)

```
Week 1: AI03 LLM Gateway
  ├── Worker: POST /generate → Workers AI
  ├── D1: org budget table
  ├── Error handling: graceful degradation on Workers AI failure
  └── Test: curl → get AI response with token count

Week 2: Data Pipeline
  ├── AI01a: Chunk lesson content (read from LMS)
  ├── AI01b: Embed with bge-m3 → index in Vectorize
  ├── AI02:  Embed query → search Vectorize → return chunks
  └── Test: Index one lesson → query it → get relevant chunks

Week 3: Tutor + Insights (parallel)
  ├── AI04a: Tutor Worker (Vectorize + AI03 → cited answers)
  └── AI08:  Insights Worker (LMS assessment data → coaching text)

Week 4: Learning Paths
  └── AI06: Paths Worker (LMS profile + catalogue + progress → AI03)

Week 5: Enhanced Recs + Polish
  ├── AI07: Enhanced recommendations (LMS recs + AI reasons)
  └── AI13: Demo Dashboard cards for all features
```

---

## What Each Worker Needs

| Worker | LMS Endpoints | CF Infra | Secrets |
|--------|--------------|----------|---------|
| AI03 | None | D1 (budget) | None (uses env.AI.run) |
| AI01a | `GET /v1/lessons/{id}` | — | `LMS_INTERNAL_KEY` |
| AI01b | `GET /v1/modules/{id}/lessons` | Vectorize, R2 | `LMS_INTERNAL_KEY` |
| AI02 | None | Vectorize | — |
| AI04a | `GET /v1/lessons/{id}` | Vectorize, AI03 binding | `LMS_INTERNAL_KEY` |
| AI06 | `GET /v1/learner/profile`, `/v1/catalog`, `/v1/progress/user`, `/v1/analytics/dashboard/skill-gaps` | AI03 binding | `LMS_INTERNAL_KEY` |
| AI07 | `GET /v1/courses/recommendations`, `/v1/learner/profile`, `/v1/progress/user` | KV (cache), AI03 binding | `LMS_INTERNAL_KEY` |
| AI08 | `GET /v1/learner/assessments/{id}`, `/v1/progress/user`, `/v1/lessons/{id}` | AI03 binding | `LMS_INTERNAL_KEY` |

---

## Success Criteria — MVP Is Done When

- [ ] **Tutor Demo:** Index 3 real lessons → ask 5 content questions → get cited, grounded answers
- [ ] **Insights Demo:** Submit a quiz → AI generates personalized coaching insight with review links
- [ ] **Paths Demo:** Generate a learning path using real learner profile + real course catalogue
- [ ] **Recs Demo:** Get course recommendations with AI-generated "why this fits" explanations
- [ ] **All features work with real LMS data** (not mock data)
- [ ] **Dashboard** at `ai.lms.example.com` shows all features working
- [ ] **Graceful degradation:** Workers AI degraded → features return ai_status:"degraded"
- [ ] **Budget enforcement:** Exhaust org budget → 429 returned, not silent failure

---

## Explicitly NOT in MVP

- ❌ No question generation (AI10a) — post-MVP
- ❌ No approval workflow (AI10b) — use LMS admin
- ❌ No quality checks (AI11) — post-MVP
- ❌ No conversation history (AI04b) — stateless Q&A only
- ❌ No platform assistant (AI09) — stretch goal
- ❌ No learner profile service (AI05) — LMS handles this
- ❌ No dedicated fail-gracefully worker (AI12) — each Worker handles its own errors
