# Slice 5: Learner Profile Service

- **Type:** AFK
- **Blocked by (internal):** Slice 0
- **Blocked by (external):** None (uses mock platform skill taxonomy)
- **User stories covered:** 1–3
- **Requirements covered:** AI-01 (Onboarding & Profile Intelligence — CV parsing deferred to Phase 2)

## Parent

`docs/vertical-slices-phase-1.md` — Slice 5: Learner Profile Service

## What to build

CRUD service for learner profiles. Each profile has four fields:

| Field | Type | Constraints |
|-------|------|-------------|
| `skills` | list of strings | Must be selected from platform skill taxonomy (validated against mock) |
| `goals` | string (free text) | Max 500 characters |
| `role` | string (optional) | Free text, no validation |
| `experience_level` | string (enum) | One of: `beginner`, `intermediate`, `advanced` |

Endpoints:

- `POST /profiles` — create profile
- `GET /profiles/{learner_id}` — read profile
- `PUT /profiles/{learner_id}` — update profile (full replace)
- `PATCH /profiles/{learner_id}` — partial update

No CV parsing in Phase 1. The requirements doc (AI-01) calls for CV parsing, but this adds significant complexity (PDF parsing, NLP extraction, multi-format support). Phase 1 relies on manual profile entry. CV parsing is tracked as a future enhancement in `Issues/future/F01-cv-parsing.md`.

## Acceptance criteria

- [ ] POST /profiles with valid skills, goals, role, experience_level → returns 201 with profile
- [ ] GET /profiles/{learner_id} → returns full profile with all fields
- [ ] PUT /profiles/{learner_id} → replaces entire profile, returns updated
- [ ] PATCH /profiles/{learner_id} → partial update, only specified fields changed
- [ ] Skill validation rejects any skill not in the platform taxonomy (returns 422 with error details)
- [ ] Goal field rejects input > 500 characters (returns 422)
- [ ] Experience level rejects values outside [beginner, intermediate, advanced] (returns 422)
- [ ] GET for nonexistent profile → returns 404
- [ ] Skill taxonomy fetched from mock platform URL at startup, cached for validation
- [ ] Profile IDs are learner-scoped (no cross-learner access in tests)
- [ ] Unit tests: all CRUD operations, all validation rules, field constraints
- [ ] Unit tests: taxonomy cache refresh behavior
- [ ] Integration tests: create → read → update → read cycle with mock platform taxonomy

## Blocked by

- Slice 0 (mock platform for skill taxonomy endpoint)
