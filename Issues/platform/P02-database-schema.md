# Platform Slice P02: Database Schema + Migrations

- **Type:** AFK
- **Blocked by:** P01 (needs `lib/db.py`)
- **User stories covered:** (infrastructure — data model for all slices)

## What to build

The SQLite schema that every platform and AI service reads from. Managed with Alembic migrations. One migration creates all tables. This slice ships the schema, the migration, and SQLAlchemy models — zero API endpoints.

### Tables

```sql
-- Courses from open sources (MIT OCW, YouTube, etc.)
CREATE TABLE courses (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    source      TEXT NOT NULL,        -- 'mit_ocw', 'youtube', 'manual'
    source_url  TEXT,
    difficulty  TEXT NOT NULL DEFAULT 'intermediate',  -- beginner/intermediate/advanced
    thumbnail_url TEXT,
    estimated_hours INTEGER,          -- Total hours to complete
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Modules (sections within a course)
CREATE TABLE modules (
    id          TEXT PRIMARY KEY,
    course_id   TEXT NOT NULL REFERENCES courses(id),
    title       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL,     -- Position within course
    description TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lessons (individual learning units)
CREATE TABLE lessons (
    id          TEXT PRIMARY KEY,
    module_id   TEXT NOT NULL REFERENCES modules(id),
    title       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL,
    content     TEXT,                 -- Full text content (chunked by AI01a)
    content_type TEXT DEFAULT 'text', -- text, markdown, html, video_transcript
    video_url   TEXT,                 -- YouTube URL if applicable
    duration_minutes INTEGER,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tags/skills associated with courses (taxonomy lives here)
CREATE TABLE tags (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE,
    domain  TEXT                     -- 'programming', 'math', 'science', etc.
);

-- Course ↔ Tags (many-to-many)
CREATE TABLE course_tags (
    course_id TEXT REFERENCES courses(id),
    tag_id    TEXT REFERENCES tags(id),
    PRIMARY KEY (course_id, tag_id)
);

-- Learners (simple auth — API key per learner)
CREATE TABLE learners (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE,
    api_key     TEXT NOT NULL UNIQUE, -- Generated on registration
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AI Learner Profile (skills, goals, experience — populated by AI05)
CREATE TABLE learner_profiles (
    learner_id      TEXT PRIMARY KEY REFERENCES learners(id),
    skills          TEXT,            -- JSON array of tag names
    goals           TEXT,            -- Free text, max 500 chars
    role            TEXT,            -- Optional job title
    experience_level TEXT DEFAULT 'beginner', -- beginner/intermediate/advanced
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enrollments (learner ↔ course)
CREATE TABLE enrollments (
    learner_id  TEXT REFERENCES learners(id),
    course_id   TEXT REFERENCES courses(id),
    enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    PRIMARY KEY (learner_id, course_id)
);

-- Lesson progress (per-learner, per-lesson)
CREATE TABLE lesson_progress (
    learner_id  TEXT REFERENCES learners(id),
    lesson_id   TEXT REFERENCES lessons(id),
    completed   BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    PRIMARY KEY (learner_id, lesson_id)
);

-- Quizzes (created by course authors or AI generation)
CREATE TABLE quizzes (
    id          TEXT PRIMARY KEY,
    lesson_id   TEXT REFERENCES lessons(id),
    title       TEXT NOT NULL,
    created_by  TEXT NOT NULL,       -- 'manual' or 'ai_generated'
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Quiz questions
CREATE TABLE quiz_questions (
    id              TEXT PRIMARY KEY,
    quiz_id         TEXT REFERENCES quizzes(id),
    question_text   TEXT NOT NULL,
    question_type   TEXT NOT NULL,   -- multiple_choice, true_false, short_answer
    options         TEXT,            -- JSON: [{text, is_correct}] for multiple_choice
    correct_answer  TEXT,            -- For true_false/short_answer
    sort_order      INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending', -- pending/approved/rejected/admin_modified
    source_chunk_id TEXT,            -- Links to AI01a chunk (for AI-generated questions)
    source_excerpt  TEXT,            -- The source text the question was generated from
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Quiz attempts (learner takes a quiz)
CREATE TABLE quiz_attempts (
    id          TEXT PRIMARY KEY,
    learner_id  TEXT REFERENCES learners(id),
    quiz_id     TEXT REFERENCES quizzes(id),
    score_pct   REAL NOT NULL,
    total_questions INTEGER NOT NULL,
    correct_count   INTEGER NOT NULL,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Per-question results within an attempt
CREATE TABLE quiz_attempt_details (
    attempt_id  TEXT REFERENCES quiz_attempts(id),
    question_id TEXT REFERENCES quiz_questions(id),
    was_correct BOOLEAN NOT NULL,
    learner_answer TEXT,
    PRIMARY KEY (attempt_id, question_id)
);

-- Conversation history (for Tutor and Assistant — AI04b, AI09)
CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    learner_id  TEXT REFERENCES learners(id),
    source      TEXT NOT NULL,        -- 'tutor' or 'assistant'
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    citations   TEXT,                 -- JSON array of citation objects
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Token usage tracking (per org per billing period — AI03)
CREATE TABLE token_usage (
    org_id      TEXT NOT NULL,
    period_start DATE NOT NULL,
    tokens_used INTEGER DEFAULT 0,
    PRIMARY KEY (org_id, period_start)
);

-- Org-level config (budget caps, defaults — for AI03, AI07)
CREATE TABLE org_config (
    org_id          TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    monthly_token_cap INTEGER DEFAULT 1000000,
    curated_defaults TEXT          -- JSON array of course IDs for recommendation fallback
);
```

### Migrations

- One initial Alembic migration (`alembic revision --autogenerate -m "initial schema"`)
- `alembic upgrade head` creates all tables in `data/sqlite/lms.db`
- `alembic downgrade -1` drops them (for `make reset`)

SQLAlchemy models live in `lib/models.py` — one class per table. All services import from `lib.models`.

## Acceptance criteria

- [ ] `alembic upgrade head` creates all tables in `data/sqlite/lms.db`
- [ ] `alembic downgrade -1` drops all tables cleanly
- [ ] SQLAlchemy models in `lib/models.py` match the schema exactly
- [ ] Every table has a corresponding model class with relationships where appropriate
- [ ] Models importable from any service: `from lib.models import Course, Learner, ...`
- [ ] UUID generation for primary keys uses `uuid4().hex` (string IDs, not auto-increment)
- [ ] Foreign key constraints enforced (SQLite supports them with `PRAGMA foreign_keys = ON`)
- [ ] `make migrate` runs the migration
- [ ] `make reset` wipes the DB and re-runs the migration
- [ ] Schema documented in `docs/schema.md` (auto-generated from models or manual ERD)

## Blocked by

- P01 — needs `lib/db.py` for engine and session factory

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
