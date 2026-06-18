# Slice 6: Personalized Learning Paths

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 3, Slice 5
- **Blocked by (external):** None (uses mock platform catalogue snapshot)
- **User stories covered:** 4–7

## Parent

`docs/vertical-slices-phase-1.md` — Slice 6: Personalized Learning Paths

## What to build

Generates a tailored learning path based on the learner's profile. Three quality tiers:

| Profile Quality | Behavior |
|----------------|----------|
| **Minimal** (< 2 skills, no goals) | Returns catalogue browse view. No generated path. Response includes `prompt: "Add more details to your profile to get a personalized path."` |
| **Partial** (some signals but low confidence) | Generates a path with `confidence: "low"` and a label: "Based on your limited profile." |
| **Rich** (skills + goals present) | Generates a full path with per-course `why_this_fits` explanation. |

Endpoint: `POST /paths/generate` — body: `{learner_id, org_id}`

The service fetches the learner's profile from Slice 5, fetches the catalogue snapshot from Slice 0, builds a prompt, calls Slice 3 (tier=standard) to generate the path, and returns:

```json
{
  "tier": "rich|partial|minimal",
  "confidence": "high|low|null",
  "label": "Based on your profile" | "Based on your limited profile" | null,
  "prompt": "Add more details..." | null,
  "courses": [
    {
      "title": "...",
      "thumbnail_url": "...",
      "estimated_effort": "4 weeks",
      "why_this_fits": "..." 
    }
  ]
}
```

Path respects course prerequisites from the Catalogue Snapshot (no course appears before its prerequisite in the order).

## Acceptance criteria

- [ ] Rich profile → returns ordered course list with per-course `why_this_fits` rationale
- [ ] Partial profile → returns path with `confidence: "low"` and "limited profile" label
- [ ] Minimal profile → returns catalogue view (all courses) with `tier: "minimal"`, prompt to add details
- [ ] Each course includes title, thumbnail_url, and estimated_effort
- [ ] Path respects prerequisites: no course appears before its prerequisite in the ordered list
- [ ] Empty catalogue → returns empty course list with appropriate message
- [ ] Slice 5 unavailable → returns 502 with error (no fallback path generation without profile)
- [ ] Slice 3 unavailable → Slice 12 handles graceful degradation; this slice returns the error upstream
- [ ] Unit tests: tier gating logic (minimal/partial/rich thresholds), prerequisite ordering
- [ ] Unit tests: LLM prompt construction for each tier
- [ ] Integration tests: create profile via Slice 5 → generate path → verify tier-appropriate output

## Blocked by

- Slice 0 (mock platform for catalogue snapshot)
- Slice 3 (LLM Gateway)
- Slice 5 (Learner Profile Service)
