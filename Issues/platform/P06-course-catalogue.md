# Platform Slice P06: Course Catalogue

- **Type:** AFK
- **Blocked by:** P03 (needs content data), P05 (needs auth to know who's browsing)
- **User stories covered:** Platform — browse, search, and discover courses

## What to build

The public-facing course catalogue. Learners browse available courses, filter by difficulty/tag, and search by title/description. No AI — pure metadata search against the database. This is the "Netflix browse page" of the LMS.

### Service: `services/catalogue/`

FastAPI app on port `8012`.

### Endpoints

```
GET  /catalogue                     Browse/filter courses
GET  /catalogue/{course_id}         Course detail page (with module list)
GET  /catalogue/search?q=python     Full-text search across courses
GET  /catalogue/tags                List all available tags with course counts
```

### Browse (`GET /catalogue`)

Query params:

| Param | Type | Description |
|-------|------|-------------|
| `difficulty` | string | Filter: `beginner`, `intermediate`, `advanced` |
| `tag` | string | Filter by tag name |
| `source` | string | Filter by source: `mit_ocw`, `youtube`, `manual` |
| `sort` | string | `title`, `newest`, `popular` (enrollment count) |
| `page` | int | Pagination offset (default 1) |
| `per_page` | int | Items per page (default 20) |

Returns:
```json
{
  "data": {
    "courses": [
      {
        "id": "...",
        "title": "Introduction to Computer Science",
        "description": "First 100 chars...",
        "difficulty": "beginner",
        "source": "mit_ocw",
        "thumbnail_url": "...",
        "estimated_hours": 120,
        "tags": ["python", "algorithms"],
        "module_count": 12,
        "lesson_count": 48,
        "enrollment_count": 342
      }
    ],
    "total": 50,
    "page": 1,
    "per_page": 20
  }
}
```

### Course detail (`GET /catalogue/{course_id}`)

Returns full course with modules (titles + lesson counts, not full lesson content):
```json
{
  "data": {
    "id": "...",
    "title": "...",
    "description": "...",
    "modules": [
      {
        "id": "...",
        "title": "Introduction to Python",
        "sort_order": 1,
        "lesson_count": 5
      }
    ],
    "tags": ["python", "algorithms"],
    "enrollment_count": 342
  }
}
```

### Search (`GET /catalogue/search?q=...`)

SQLite `LIKE` search across `title` and `description`. Supports the same filter/sort/page params as browse. Results ranked by relevance (title match > description match).

### Tags (`GET /catalogue/tags`)

Returns all tags with how many courses use each:
```json
{
  "data": {
    "tags": [
      {"name": "python", "course_count": 8, "domain": "programming"},
      {"name": "algorithms", "course_count": 5, "domain": "computer-science"}
    ]
  }
}
```

This endpoint is the skill taxonomy that AI05 (Learner Profile) uses for validation.

### Auth

All endpoints are public — no auth required. The browse catalogue is the landing page of the LMS.

## Acceptance criteria

- [ ] GET /catalogue → returns all courses, paginated (default 20 per page)
- [ ] GET /catalogue?difficulty=beginner → only beginner courses
- [ ] GET /catalogue?tag=python → only courses tagged "python"
- [ ] GET /catalogue?source=mit_ocw → only MIT courses
- [ ] GET /catalogue?sort=popular → ordered by enrollment count descending
- [ ] GET /catalogue → page 2 returns next 20 courses, total count consistent
- [ ] GET /catalogue/{id} → course detail with modules (titles only, not content)
- [ ] GET /catalogue/search?q=python → courses with "python" in title or description
- [ ] Search respects active filters (difficulty + tag + search term combined)
- [ ] GET /catalogue/tags → all tags with accurate course counts
- [ ] Empty catalogue → returns empty array, not error
- [ ] Invalid course ID → returns 404
- [ ] No auth required on any endpoint
- [ ] Unit tests: filter combinations, pagination edge cases, search ranking
- [ ] Integration tests: P03 creates courses → P04 imports content → catalogue displays it

## Blocked by

- P03 — needs Content Management for course data
- P05 — needed for enrollment counts (popular sort); can hardcode to 0 until P07 ships

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
