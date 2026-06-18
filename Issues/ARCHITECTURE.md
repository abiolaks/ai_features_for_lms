# Architecture & Implementation Flow

How all 29 slices fit together — the big picture.

## Overall Architecture

```
                          localhost:8000
                    ┌──────────────────────┐
                    │   Platform Gateway    │  P10 — single entry point
                    │   Auth at the edge    │
                    └──────┬───────────────┘
           ┌───────────────┼───────────────────────────┐
           │               │                           │
    ┌──────▼──────┐ ┌──────▼──────┐            ┌──────▼──────┐
    │   PLATFORM   │ │     AI       │            │   FRONTEND   │
    │   SERVICES   │ │   SERVICES   │            │              │
    └──────────────┘ └──────────────┘            └──────────────┘
           │               │                           │
    ┌──────┼───────┐ ┌─────┼──────────┐     ┌────────┼────────┐
    │      │       │ │     │          │     │        │        │
    ▼      ▼       ▼ ▼     ▼          ▼     ▼        ▼        ▼
  P03    P05      P08 AI03  AI04a    AI10a  P00     P09      AI13
 Content Accounts  Quiz LLM   Tutor   Q-Gen  UI     Admin    Demo
                    │   │     │               Lib    Dash     Dash
                    │   │     │
                    │   ▼     ▼
                    │  AI02  AI04b
                    │  RAG   History
                    │   │
                    │   ▼
                    │  AI01b
                    │  Index
                    │   │
                    │   ▼
                    │  AI01a
                    │  Chunk
                    │
                    ▼
                 P01b
               Phoenix
              (observability)

         ┌─────────────────┐
         │   SQLite (P02)   │  ← Single database. All services read/write.
         └─────────────────┘

         ┌─────────────────┐
         │  LanceDB (AI01b) │  ← Embedded vector DB. Files in data/lancedb/
         └─────────────────┘

         ┌─────────────────┐
         │  Ollama (AI03)   │  ← Local LLM server. llama3.2 + mistral.
         └─────────────────┘
```

## Implementation Flow (14 waves)

```
WAVE 1 — Foundation                   WAVE 2 — Data
┌─────────────────────┐              ┌─────────────────────┐
│ P00  UI Components  │              │ P02  DB Schema      │
│ P01  Project Scaffold│              │ P05  Learner Auth   │
│ P01b Phoenix+OTel   │              └─────────────────────┘
│ AI13 Demo Dashboard │
└─────────────────────┘

WAVE 3 — Content Core                WAVE 4 — Content Ecosystem
┌─────────────────────┐              ┌─────────────────────┐
│ P03  Content CRUD   │              │ P04  Ingest (MIT/YT) │
└─────────────────────┘              │ P06  Catalogue       │
                                     │ P08  Quiz Engine     │
                                     └─────────────────────┘

WAVE 5 — Learner Journey             WAVE 6 — Admin
┌─────────────────────┐              ┌─────────────────────┐
│ P07  Enroll+Progress│              │ P09  Admin Dashboard │
└─────────────────────┘              └─────────────────────┘

WAVE 7 — Unify                       WAVE 8 — AI Foundation
┌─────────────────────┐              ┌─────────────────────┐
│ P10  Platform Gateway│              │ AI01a Chunking      │
└─────────────────────┘              │ AI03  LLM Gateway   │
                                     │ AI05  Learner Profile│
                                     └─────────────────────┘

WAVE 9 — AI Data Layer               WAVE 10 — AI Features
┌─────────────────────┐              ┌─────────────────────┐
│ AI01b Indexing      │              │ AI04a Tutor Core    │
│ AI02  RAG Retrieval │              │ AI06  Learning Paths│
└─────────────────────┘              │ AI07  Recommendations│
                                     │ AI08  Quiz Insights  │
                                     │ AI10a Question Gen  │
                                     └─────────────────────┘

WAVE 11 — AI Polish                  WAVE 12 — Quality
┌─────────────────────┐              ┌─────────────────────┐
│ AI04b Tutor History │              │ AI11  Quality Checks│
│ AI09  Assistant     │              └─────────────────────┘
│ AI10b Approval Flow │
└─────────────────────┘

WAVE 13 — Resilience                 DONE
┌─────────────────────┐              ┌─────────────────────┐
│ AI12  Graceful Fail │              │ All 29 slices       │
└─────────────────────┘              │ shipped             │
                                     └─────────────────────┘
```

## Request Flow: "Ask the Tutor a Question"

How a learner's question flows through 6 services:

```
Learner: "What is a Python list comprehension?"
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ P10  Gateway (:8000)                                         │
│ Validates X-API-Key → resolves learner_id, org_id            │
│ Routes to AI service                                         │
└──────────────────────────┬───────────────────────────────────┘
                           │
    ┌──────────────────────┘
    ▼
┌──────────────────────────────────────────────────────────────┐
│ AI04a  Tutor Core                                            │
│ 1. Receives: {question, lesson_id, org_id, learner_id}       │
│ 2. Calls AI02 for retrieval                                  │
│ 3. Calls AI03 for LLM generation                             │
│ 4. Calls AI04b to store history                              │
└──────┬───────────────┬───────────────┬───────────────────────┘
       │               │               │
       ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ AI02  RAG    │ │ AI03  Gateway│ │ AI04b History│
│              │ │              │ │              │
│ Query:       │ │ Prompt:      │ │ Store:       │
│ "Python list │ │ "Answer using│ │ {question,   │
│  comprehension│ │ ONLY this   │ │  answer,     │
│  in lesson X" │ │  content..."│ │  citations}  │
│              │ │              │ │              │
│ Scope:lesson │ │ Tier:standard│ │ learner_id   │
│              │ │ Model:llama  │ │              │
│    │         │ │   3.2        │ │              │
│    ▼         │ │    │         │ │              │
│ LanceDB ─────┘ │    ▼         │ └──────────────┘
│ Returns top-5  │ Ollama       │
│ chunks with    │ Returns      │
│ scores         │ answer text  │
└────────────────┴──────────────┘
       │               │
       └───────┬───────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ Response to learner:                                         │
│ {                                                            │
│   answer: "A list comprehension is a compact way to create   │
│            lists in Python. Instead of writing a for loop..." │
│   citations: [                                               │
│     { lesson_title: "Python Basics",                         │
│       section: "List Operations",                            │
│       timestamp: "12:34",                                    │
│       excerpt: "List comprehensions provide a concise..." }  │
│   ]                                                          │
│ }                                                            │
└──────────────────────────────────────────────────────────────┘

Every step traced in Phoenix:
  gateway.request (5ms) → tutor.ask (1.5s total)
    ├── retrieval.search (85ms) → 5 chunks, top score 0.92
    ├── llm.generate (1.2s) → 450 tokens in, 180 tokens out
    └── history.store (12ms)
```

## Request Flow: "Generate a Learning Path"

```
Learner: clicks "Generate Path"
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ AI06  Learning Paths                                         │
│ 1. Fetches profile from AI05                                │
│ 2. Fetches catalogue from P06                               │
│ 3. Evaluates profile richness → gates to tier               │
│ 4. Builds prompt, calls AI03 (tier=standard)                │
│ 5. Returns ordered course list with rationales              │
└──────┬───────────────┬───────────────┬───────────────────────┘
       │               │               │
       ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ AI05 Profile │ │ P06 Catalogue│ │ AI03 Gateway │
│              │ │              │ │              │
│ skills:      │ │ 15 courses   │ │ Prompt:      │
│  [python,    │ │ with tags,   │ │ "Given this  │
│   beginner]  │ │ difficulty,  │ │  profile and │
│              │ │ prereqs      │ │  catalogue,  │
│ goals:       │ │              │ │  create a    │
│  "learn ML"  │ │              │ │  learning    │
│              │ │              │ │  path..."    │
│ experience:  │ │              │ │              │
│  beginner    │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
       │               │               │
       └───────┬───────┘               │
               │                       │
        Profile quality:               │
        3 skills + goals               │
        → tier = "rich"                │
        → confidence = "high"          │
                                       │
               ┌───────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ Response:                                                    │
│ {                                                            │
│   tier: "rich",                                              │
│   confidence: "high",                                        │
│   courses: [                                                 │
│     { title: "Python Basics",                                │
│       why_this_fits: "Matches your beginner level and        │
│        Python skill. Builds foundation for ML track." },     │
│     { title: "Data Science Fundamentals",                    │
│       why_this_fits: "Bridges your Python skills to your     │
│        ML goal. Covers pandas, numpy, and statistics." }     │
│   ]                                                          │
│ }                                                            │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow: Content Ingestion → AI Indexing

```
┌──────────────────────────────────────────────────────────────┐
│ P04  Content Ingestion                                       │
│                                                              │
│ MIT OCW scraper ──→ P03 Content API ──→ SQLite               │
│ YouTube importer ──→ P03 Content API ──→ SQLite               │
│ Manual YAML ──────→ P03 Content API ──→ SQLite               │
│                                                              │
│ Result: courses, modules, lessons with full text in DB       │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ AI01b  Indexing Orchestrator                                 │
│                                                              │
│ Trigger: POST /index?path=course-1/module-2/lesson-3         │
│                                                              │
│ 1. Read lesson content from SQLite                           │
│ 2. Call AI01a: chunk text → [{text, metadata, position}]    │
│ 3. Embed chunks: sentence-transformers → 384-dim vectors    │
│ 4. Index: LanceDB.insert(chunks + vectors + metadata)       │
│                                                              │
│ LanceDB schema:                                              │
│   text: str                                                  │
│   vector: float[384]                                         │
│   org_id: str                                                │
│   course_id: str                                             │
│   module_id: str                                             │
│   lesson_id: str                                             │
│   section_heading: str                                       │
│   chunk_index: int                                           │
└──────────────────────────────────────────────────────────────┘
```

## Degradation Flow (AI12)

```
Normal operation:
┌─────────┐     ┌─────────┐     ┌─────────┐
│ AI04a   │────→│ AI02    │────→│ AI03    │──→ Response with answer
│ Tutor   │     │ RAG     │     │ Gateway │
└─────────┘     └─────────┘     └─────────┘

Gateway down (AI12 active):
┌─────────┐     ┌─────────┐     ┌─────────┐
│ AI04a   │────→│ AI02    │────→│ AI03    │ ✗ DOWN
│ Tutor   │     │ RAG     │     │ Gateway │
└─────────┘     └─────────┘     └────┬────┘
                                     │
                              Health check cache:
                              "gateway=down" (refreshed every 30s)
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────┐
│ AI04a returns immediately:                                   │
│ {                                                            │
│   ai_status: "degraded",                                     │
│   answer: null,                                              │
│   message: "AI tutor is temporarily unavailable.             │
│             Your course content and quizzes are still        │
│             fully accessible."                               │
│ }                                                            │
└──────────────────────────────────────────────────────────────┘

All AI features degrade the same way:
  AI06 Paths → returns courses without AI explanations
  AI07 Recs  → falls back to rule-based cascade (Slice 7 built-in)
  AI08 Insights → returns placeholder
  AI09 Assistant → returns degraded signal
  AI10a Q-Gen → returns degraded signal
```

## Service Dependency Map

```
                    P00 ────────────────┐
                    P01 ────────────────┤
                    P01b────────────────┤
                    AI13────────────────┤  Wave 1: Foundation
                                        │
                    P02 ────────────────┤
                    P05 ────────────────┤  Wave 2: Data
                                        │
            ┌────── P03 ────────────────┤  Wave 3: Content
            │                           │
    ┌───────┼───────┬───────────────────┤
    │       │       │                   │
    ▼       ▼       ▼                   │
   P04     P06     P08 ────────────────┤  Wave 4: Ecosystem
    │       │       │                   │
    │       │       │                   │
    └───────┼───────┘                   │
            ▼                           │
           P07 ────────────────────────┤  Wave 5: Journey
            │                           │
            ▼                           │
           P09 ────────────────────────┤  Wave 6: Admin
            │                           │
            ▼                           │
           P10 ════════════════════════╡  Wave 7: Gateway
            │                           ║
    ┌───────┼───────────────┐           ║
    ▼       ▼               ▼           ║
  AI01a   AI03            AI05 ────────┤  Wave 8: AI Foundation
    │       │               │           ║
    ▼       │               │           ║
  AI01b     │               │           ║
    │       │               │           ║
    ▼       │               │           ║
  AI02 ─────┘               │           ║
    │       │               │           ║
    └───┬───┘               │           ║
        │                   │           ║
   ┌────┼────┬────┬─────────┤           ║
   ▼    ▼    ▼    ▼         ▼           ║
 AI04a AI06 AI07 AI08    AI10a ────────┤  Wave 10: AI Features
   │    │    │    │         │           ║
   ▼    │    │    │         ▼           ║
 AI04b  │    │    │       AI10b ───────┤  Wave 11: AI Polish
   │    │    │    │         │           ║
   │    │    │    │         ▼           ║
   │    │    │    │       AI11 ────────┤  Wave 12: Quality
   │    │    │    │                     ║
   └────┴────┴────┴────────────────────┤
                                       │
                  AI12 ────────────────┤  Wave 13: Resilience
                                       │
                              ALL DONE ┘
```

## Port Map

```
:8000  Platform Gateway (P10)
:6006  Phoenix UI (P01b)
:4317  Phoenix OTLP collector (P01b)
:8002  Demo Dashboard (AI13)
:8005  UI Style Guide (P00)
:8010  Content Management (P03)
:8011  Learner Accounts (P05)
:8012  Course Catalogue (P06)
:8013  Enrollment & Progress (P07)
:8014  Quiz Engine (P08)
:8015  Admin Dashboard (P09)
:10000 Azurite Blob Emulator (P01)
```

## What You See at Each Checkpoint

```
Wave 1 done ──────────────────────────────────────────────────
  Dashboard at :8002 shows:
    [Progress] ████░░░░░░░░ 4/29 · 13.8%
    Platform tab: empty
    AI tab: empty
  Phoenix at :6006 shows:
    Trace ingestion active, but no data yet

Wave 3 done ──────────────────────────────────────────────────
  Dashboard shows:
    [Progress] ██████░░░░░░ 6/29 · 20.7%
    [Platform] ┌─ Courses ──────────────────────────┐
               │ 6.0001 Intro to CS    beginner  MIT │
               │ 18.01  Calculus I     beginner  MIT │
               │ Python Basics        beginner  YAML │
               └─────────────────────────────────────┘

Wave 7 done ──────────────────────────────────────────────────
  Dashboard shows:
    [Progress] ████████████ 12/29 · 41.4%
    [Platform] Courses · Register · Catalogue · Progress ·
               Quizzes · Admin
    Gateway on :8000 unifies all services

Wave 10 done ──────────────────────────────────────────────────
  Dashboard shows:
    [Progress] ██████████████████ 22/29 · 75.9%
    [Platform] Full LMS operational
    [AI]       Tutor chat · Paths · Recommendations ·
               Insights · Question Generator
    Phoenix: rich waterfalls with LLM + retrieval spans

Wave 13 done ──────────────────────────────────────────────────
  Dashboard shows:
    [Progress] ████████████████████████ 29/29 · 100%
    All features live. Degradation toggle works.
    Phoenix: full traces across all services.
```
