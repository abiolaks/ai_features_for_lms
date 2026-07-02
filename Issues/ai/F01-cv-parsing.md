GitHub Issue: [#11](https://github.com/datazone-ai/ai_features_for_lms/issues/11)

# Future: F01 — CV Parsing for Learner Profiles

- **Phase:** 2
- **Requirements covered:** AI-01 (Onboarding & Profile Intelligence — CV parsing)
- **Depends on:** AI05 (Learner Profile Service)

## What to build

Add CV/resume parsing to the Learner Profile Service (AI05). A learner uploads a PDF or DOCX resume, and the system extracts:

- **Skills** — matched against the platform skill taxonomy (from P06 catalogue tags)
- **Role/title** — current or most recent job title
- **Experience level** — inferred from years of experience (0-2 → beginner, 2-5 → intermediate, 5+ → advanced)
- **Goals** — not extracted from CV (manual entry only)

The extracted fields pre-populate the profile form. The learner reviews and confirms before saving — nothing is auto-saved without explicit learner approval.

### Tech

- **PDF parsing:** `pypdf` or `pdfplumber` for text extraction
- **DOCX parsing:** `python-docx`
- **Skill extraction:** LLM call (tier=standard) with a prompt like: "Extract professional skills from this resume text. Return only skills that match this taxonomy: [taxonomy_list]."
- **Role extraction:** LLM call — "What is this person's current or most recent job title?"
- **Experience level:** Heuristic from years (extracted by LLM or regex on date ranges)

### Endpoint

```
POST /profiles/{learner_id}/parse-cv
Content-Type: multipart/form-data
file: resume.pdf

→ {skills: [...], role: "Software Engineer", experience_level: "intermediate"}
```

## Acceptance criteria

- [ ] Upload PDF resume → skills extracted and matched against taxonomy
- [ ] Upload DOCX resume → same behavior
- [ ] Skills not in taxonomy are excluded (with warning in response)
- [ ] Role/title extracted accurately for common formats
- [ ] Experience level inferred from years (beginner/intermediate/advanced)
- [ ] Learner must confirm before profile is saved (extracted fields are suggestions only)
- [ ] Unparseable file → returns 422 with helpful error
- [ ] File too large (>5MB) → returns 413
- [ ] Unit tests: extraction accuracy with sample resumes, taxonomy matching
