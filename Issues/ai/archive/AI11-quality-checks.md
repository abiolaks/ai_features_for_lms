# Slice 11: Quality Checks

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 10b
- **Blocked by (external):** None (course difficulty from mock platform; admin publish gate UI is platform team scope)
- **User stories covered:** 32–35

## Parent

`docs/vertical-slices-phase-1.md` — Slice 11: Quality Checks

## What to build

Pre-publish quality checks on approved assessment questions. Two check types run as a gate when admin triggers publish validation.

**Checks:**

| Check | Method | Behavior |
|-------|--------|----------|
| **Duplicate detection** | Semantic similarity via embedding comparison (cosine similarity) using `sentence-transformers` `all-MiniLM-L6-v2` | Identifies question pairs with similarity > threshold. Flags them, presents both to admin for manual resolution. Does NOT auto-merge or auto-delete. |
| **Reading level** | Flesch-Kincaid grade estimation via `textstat` | Compares question text reading grade against course difficulty: Beginner (grade 6-8), Intermediate (grade 9-12), Advanced (grade 13+). Flags mismatches. See `Issues/TECH_PRINCIPLES.md`. |

Endpoint: `POST /assessments/{assessment_id}/check` — runs both checks and returns:

```json
{
  "passed": false,
  "duplicates": [
    {"question_a_id": "q1", "question_b_id": "q5", "similarity": 0.92}
  ],
  "reading_level_issues": [
    {"question_id": "q3", "question_grade": 14, "course_grade": 8, "direction": "above"}
  ],
  "can_publish": false
}
```

**Resolution:** Duplicates are resolved manually by the admin via Slice 10b (reject one, keep the other). Reading level issues are resolved by editing the question text (Slice 10b) or acknowledging the mismatch. After resolution, re-running `/check` returns `can_publish: true`.

**Publish gate:** `can_publish: true` when zero duplicates flagged AND zero reading level issues unresolved. This is an advisory flag — the actual publish action is platform team scope.

## Acceptance criteria

- [ ] Two semantically similar questions → flagged as potential duplicate with similarity score
- [ ] Dissimilar questions → not flagged (low similarity score)
- [ ] Duplicate detection threshold is configurable via env var (`DUPLICATE_SIMILARITY_THRESHOLD`, default 0.85)
- [ ] Question reading level above course difficulty → flagged as `direction: "above"`
- [ ] Question reading level below course difficulty → flagged as `direction: "below"`
- [ ] Question reading level matches course difficulty → not flagged
- [ ] All checks pass → `can_publish: true`
- [ ] Duplicates flagged → `can_publish: false`
- [ ] Reading level issues → `can_publish: false`
- [ ] Assessment with no questions → returns 422
- [ ] Assessment with only rejected questions → skips checks, returns `can_publish: false`
- [ ] Re-running check after admin resolves issues (reject duplicate, edit reading level) → `can_publish: true`
- [ ] Unit tests: cosine similarity calculation (sentence-transformers), reading grade estimation (textstat), threshold boundaries
- [ ] Unit tests: `can_publish` logic with various combinations of issues
- [ ] Integration tests: generate assessment via 10a → approve via 10b → run checks → verify flags → resolve via 10b → re-run checks → verify pass

## Blocked by

- Slice 0 (mock platform for course difficulty)
- Slice 10b (approved questions to check; approval workflow for resolution)
