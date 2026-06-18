# Future: F02 — Mentor Matching

- **Phase:** 2
- **Requirements covered:** AI-10 (Mentor Matching)
- **Depends on:** AI05 (Learner Profile), a Mentor Directory data product (not yet built)

## What to build

Connect learners with mentors. Given a learner's profile (skills, goals, experience level), find mentors whose expertise matches, and return a ranked list with compatibility scores and human-readable reasons.

### Endpoints

```
POST /mentor/match
Body: {learner_id, org_id, limit?: 5}

→ {
    matches: [
      {
        mentor_id: "...",
        mentor_name: "Dr. Sarah Chen",
        compatibility_score: 0.87,
        reasons: [
          "Expert in Python and algorithms — matches your learning goals",
          "Has mentored 12 learners with similar skill profiles",
          "Available during your preferred time window (evenings)"
        ],
        specializations: ["python", "algorithms", "machine-learning"],
        availability: "weekday evenings"
      }
    ]
  }
```

### Matching algorithm

1. Fetch learner profile from AI05 (skills, goals, experience level)
2. Fetch mentor directory from Mentor Directory data product (skills, specializations, availability, past mentees)
3. Score each mentor on:
   - **Skill overlap** (40%) — how many learner skills/goals match mentor specializations
   - **Experience level match** (20%) — mentor has mentored at this level before
   - **Availability match** (15%) — time windows overlap
   - **Success record** (15%) — past mentee outcomes (if available)
   - **Diversity bonus** (10%) — prioritize mentors with complementary (not identical) skills
4. Return top-N with scores and per-match reasons
5. Call Slice 3 (tier=standard) to generate human-readable reason strings

### Mentor Directory data product

This requires a new data source — a directory of mentors with:
- Profile (name, bio, photo)
- Specializations (skills mapped to taxonomy)
- Availability (time windows per week)
- Past mentee count and outcomes
- Org affiliation

This data product is out of scope for the AI layer — it's a platform team deliverable.

## Acceptance criteria

- [ ] Rich learner profile → returns ranked mentors with compatibility scores
- [ ] Each match includes ≥1 human-readable reason
- [ ] Minimal learner profile → returns mentors sorted by general availability (no skill matching)
- [ ] Empty mentor directory → returns empty list with message
- [ ] Cross-org matching prevented (only mentors in learner's org)
- [ ] Scoring weights are configurable via env vars
- [ ] Unit tests: scoring algorithm, reason generation, empty/edge cases
