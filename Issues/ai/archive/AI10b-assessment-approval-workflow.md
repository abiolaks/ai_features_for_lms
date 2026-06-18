# Slice 10b: Assessment Approval Workflow

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 10a
- **Blocked by (external):** None (admin actions via HTTP; admin review UI is platform team scope)
- **User stories covered:** 26–31 (approval state machine, batch ops, staleness detection)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 10: Assessment Generation (split — approval workflow concern)

## What to build

Approval workflow for generated assessments. Manages question state through a state machine and detects stale questions when source content changes.

**State machine:**

```
pending → approved
pending → rejected
pending → (edited) → admin_modified + approved
```

No `draft` or `published` states on individual questions — questions are either in the set or not. The publish gate is in Slice 11.

**Endpoints:**

- `POST /assessments/{assessment_id}/questions/{question_id}/approve` — single approve
- `POST /assessments/{assessment_id}/questions/{question_id}/reject` — single reject
- `POST /assessments/{assessment_id}/approve-all` — batch approve all pending
- `POST /assessments/{assessment_id}/reject-all` — batch reject all pending
- `PUT /assessments/{assessment_id}/questions/{question_id}` — edit question inline. Sets `status: "admin_modified"`, preserves original source trace, adds `edited_by: "admin"` and `edited_at` timestamp.

**Staleness detection:**

When the source lesson is re-indexed (Slice 1b), approved/admin_modified questions referencing chunks from that lesson are flagged. Endpoint:

- `GET /assessments/{assessment_id}/stale` → returns list of questions where source lesson has been updated since the question was generated/approved. Compares `generated_at` (or `edited_at` for admin_modified) against the lesson's `last_indexed_at` timestamp.

**Storage:** Persists assessment-question relationships. An assessment is a collection of generated questions tied to a lesson.

## Acceptance criteria

- [ ] POST .../approve → question status changes to `approved`
- [ ] POST .../reject → question status changes to `rejected`
- [ ] POST .../approve-all → all pending questions in assessment become `approved`
- [ ] POST .../reject-all → all pending questions in assessment become `rejected`
- [ ] PUT .../edit → question text/options updated, `status: "admin_modified"`, `edited_by` and `edited_at` set
- [ ] Admin-modified questions keep their original source trace (not lost on edit)
- [ ] Approving an already-approved question → returns 409 (idempotent conflict)
- [ ] Rejecting an already-rejected question → returns 409
- [ ] GET .../stale → returns questions where lesson `last_indexed_at` > question `generated_at` or `edited_at`
- [ ] No stale flag when lesson hasn't been re-indexed since generation
- [ ] Unit tests: all state machine transitions, invalid transitions (409), batch operations
- [ ] Unit tests: admin-modified trace preservation, staleness comparison logic, edge cases
- [ ] Integration tests: generate via 10a → approve one, reject one, edit one → verify all states → re-index lesson via 1b → verify stale detection

## Blocked by

- Slice 0 (mock platform)
- Slice 10a (question generation — provides the questions to approve/reject/edit)
