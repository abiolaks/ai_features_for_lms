# AI Engineer — Ownership & Deliverables

## Your Lane

Everything between platform data inputs and AI responses. The platform team provides data in and consumes responses out.

## Deliverables

### Core Infrastructure

| Deliverable | What You Build | Depends on Platform For |
|---|---|---|
| **Content Indexing Service** | Chunking engine, embedding generation, vector DB storage schema, index/de-index pipeline | Publish/update/delete events, raw content (transcripts, lesson text) |
| **RAG Retrieval Engine** | Vector search, scope filtering, citation assembly, groundedness enforcement | Content Corpus data product (embedded chunks), org context from middleware |
| **LLM Gateway** | Provider abstraction, model routing (fast vs capable), token counting, budget enforcement | Org context, API keys/config |
| **Usage Budgeting Service** | Token caps per org, throttle state machine, reset logic | Org admin config for cap values |

### Feature Services

| Deliverable | What You Build | Depends on Platform For |
|---|---|---|
| **Tutor Service (AI-04)** | Grounded Q&A logic, conversation history CRUD, scope expansion flow, 30-day purge job | Lesson context, auth, UI for chat surface |
| **Path Generation Service (AI-02)** | Prompt engineering for path generation, tiered gating logic, explanation generation | Catalogue Snapshot, Learner Profile, UI for path display |
| **Recommendation Engine (AI-03)** | AI + rule-based fallback cascade, 24hr cache logic | Catalogue Snapshot, Learner Context, admin-curated defaults config |
| **Post-Activity Insight Service (AI-06)** | Quiz result → coaching prompt, tone logic by score, review link generation | Quiz results, lesson structure for review links |
| **Platform Assistant Service (AI-16)** | Intent routing (navigation vs content), Tutor handoff logic | Learner progress/enrollment data, UI for assistant widget |
| **Assessment Generation Service (AI-08/09)** | Question generation via RAG + LLM, approval state machine, dupe detection, reading level check, staleness detection | Source lesson content, course difficulty field, admin UI for review panel |

## What Platform Team Owns

- Learner Profile CRUD and storage
- Multi-Tenant Security Middleware
- Data Products (4 curated views)
- Skill taxonomy
- Course/module/lesson data model
- Quiz engine and result storage
- Auth, org management, user management
- All UI/frontend rendering
- Content authoring and publish workflows
- Events that trigger indexing (publish, update, delete)

## Data Flow Contract

```
┌─────────────────────────────┐
│      PLATFORM LAYER         │
│  (Courses, Quizzes, Auth,   │
│   Profile, UI, Events)      │
└──────────┬──────────────────┘
           │  Data Products, Events, Context
           ▼
┌─────────────────────────────┐
│     YOUR AI LAYER           │
│                             │
│  ┌─ Indexing ─────────────┐ │
│  └─ RAG Engine ───────────┘ │
│  ┌─ LLM Gateway ──────────┐ │
│  └─ Budgeting ────────────┘ │
│  ┌─ Tutor ────────────────┐ │
│  └─ Path Gen ─────────────┘ │
│  ┌─ Rec Engine ───────────┐ │
│  └─ Insights ─────────────┘ │
│  ┌─ Assistant ────────────┐ │
│  └─ Assessment Gen ───────┘ │
└──────────┬──────────────────┘
           │  AI Responses (answers, paths, recs, questions, insights)
           ▼
┌─────────────────────────────┐
│      PLATFORM LAYER         │
│        (UI renders it)      │
└─────────────────────────────┘
```

## API Surface (Your Contract with Platform)

### You Consume

| Input | From | Format |
|---|---|---|
| Content publish/update/delete events | Platform event bus | Event payload with content ID, org ID, lesson/module/course metadata |
| Raw content (transcripts, text) | Content storage | Plain text or structured text per lesson |
| Data Products (DP-1 through DP-4) | Platform data layer | Read-only curated views |
| Authenticated user context (org ID, learner ID) | Multi-tenant middleware | Request headers/context |
| Quiz results | Quiz engine | Score, per-question results, lesson/course context |
| Org budget config | Admin settings | Token cap per month per org |

### You Expose

| Output | To | Format |
|---|---|---|
| Tutor answer + citations | UI (lesson page) | Text response with inline citation references |
| Learning path + explanations | UI (dashboard) | Ordered course list with per-course rationale |
| Recommendations + reasons | UI (dashboard, sidebar) | Top-N items with one-sentence reason each |
| Post-quiz insight + review links | UI (quiz results page) | Encouraging text + lesson/section links |
| Generated assessment questions + source traces | UI (admin review panel) | Questions with source excerpt and metadata |
| Quality check results | UI (publish gate) | Flagged duplicates and reading level mismatches |
| Platform assistant response | UI (assistant widget) | Text response or handoff suggestion |
