# F09: Assessment Approval Workflow (AI10b)

- **Type:** Split (AI + LMS)
- **Phase:** 3
- **Depends on:** F07 (Question Generation), F08 (Quality Checks), LMS Admin Dashboard

## What to build

Admin review and approval pipeline for AI-generated quiz questions. Generated questions are stored in a staging area where admins can review, edit, approve, or reject before they go live.

**AI team responsibilities:**
- `POST /questions/store` — save generated questions with status `pending_review`
- `GET /questions/pending?org_id=` — list pending questions for admin review
- `POST /questions/{id}/status` — update status (approved/rejected/edited)
- D1 schema for question storage + review state

**LMS team responsibilities:**
- Admin UI: review panel showing questions in context (source lesson)
- Admin UI: approve/reject/edit actions
- Admin UI: bulk approve workflow
- Integration: call AI worker endpoints from LMS admin dashboard

**Behavior:**
1. F07 generates questions → stored in D1 with `status: pending_review`
2. F08 validates → passes/fails each question, stores results
3. Admin opens review panel (LMS) → fetches pending questions via `GET /questions/pending`
4. Admin reviews each question in context of source lesson
5. Admin approves (question goes live), rejects (archived), or edits (resubmits)
6. Approved questions are published to the LMS quiz engine

## D1 Schema

```sql
CREATE TABLE IF NOT EXISTS generated_questions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  text TEXT NOT NULL,
  options TEXT NOT NULL,           -- JSON array
  correct_answer TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',  -- pending_review, approved, rejected, edited
  quality_score REAL,              -- from F08 validation
  quality_issues TEXT,             -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE INDEX idx_questions_status ON generated_questions(org_id, status);
CREATE INDEX idx_questions_lesson ON generated_questions(lesson_id);
```

## Acceptance criteria

- [ ] D1 schema created with migrations
- [ ] `POST /questions/store` saves generated questions
- [ ] `GET /questions/pending` returns review queue filtered by org
- [ ] `POST /questions/{id}/status` updates question state
- [ ] Quality check results from F08 stored alongside questions
- [ ] Rejected questions archived with reason
- [ ] Unit tests: CRUD operations, status transitions
- [ ] Integration: LMS admin dashboard (LMS team deliverable)
