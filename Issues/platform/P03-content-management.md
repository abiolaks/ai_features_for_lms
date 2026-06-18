# Platform Slice P03: Content Management

- **Type:** AFK
- **Blocked by:** P01, P02
- **User stories covered:** Platform — CRUD for courses, modules, lessons, tags

## What to build

REST API for managing the content catalogue. This is the first slice with actual endpoints — course authors (or importers in P04) create courses, modules, and lessons here.

### Service: `services/content/`

FastAPI app on port `8010`.

### Endpoints

**Courses:**
```
POST   /courses                    Create course
GET    /courses                    List all courses (?difficulty=, ?tag=)
GET    /courses/{course_id}        Get course with modules
PUT    /courses/{course_id}        Update course
DELETE /courses/{course_id}        Delete course + cascade modules/lessons
```

**Modules:**
```
POST   /courses/{course_id}/modules           Add module
GET    /courses/{course_id}/modules            List modules (ordered by sort_order)
PUT    /courses/{course_id}/modules/{mod_id}   Update module
DELETE /courses/{course_id}/modules/{mod_id}   Delete module + cascade lessons
```

**Lessons:**
```
POST   /modules/{module_id}/lessons            Create lesson with content
GET    /modules/{module_id}/lessons             List lessons (ordered by sort_order)
GET    /lessons/{lesson_id}                     Get lesson with full content
PUT    /lessons/{lesson_id}                     Update lesson (content, title, etc.)
DELETE /lessons/{lesson_id}                     Delete lesson
```

**Tags:**
```
POST   /tags                      Create tag (name + domain)
GET    /tags                      List all tags (?domain=)
DELETE /tags/{tag_id}             Delete tag
```

**Course-Tag association:**
```
POST   /courses/{course_id}/tags       Add tag to course
DELETE /courses/{course_id}/tags/{tag_id}  Remove tag from course
```

### Content storage

Lesson content is stored directly in the `lessons.content` column (SQLite TEXT column — fine for content up to a few MB). For video transcripts, the `content_type` field distinguishes `text`, `markdown`, `html`, and `video_transcript`. Raw files (PDFs, HTML downloads) go to `data/blobs/raw/{course_id}/{module_id}/{lesson_id}/` for the indexing pipeline (AI01a) to process.

### Validation

- Course `difficulty` must be one of: `beginner`, `intermediate`, `advanced`
- Module `sort_order` auto-increments within a course if not provided
- Lesson `sort_order` auto-increments within a module if not provided
- Tag `name` is unique across the system
- Cascade delete: deleting a course removes its modules → lessons → course_tags

### Response format

All responses follow the shared error format from `lib/errors.py`:
```json
{
  "data": { ... },
  "error": null
}
```

## Acceptance criteria

- [ ] Full CRUD cycle for courses: create → read → update → delete → verify cascade
- [ ] Full CRUD cycle for modules: create under course → reorder → delete
- [ ] Full CRUD cycle for lessons: create under module → update content → delete
- [ ] Tags: create, list by domain, delete (reject if used by any course)
- [ ] Course-tag association: add tag → list course shows tags → remove tag
- [ ] Course listing supports `?difficulty=beginner` and `?tag=python` filters
- [ ] Delete course → all modules, lessons, and course_tags cascade-deleted
- [ ] Delete module → all lessons cascade-deleted
- [ ] Lesson content stored as plain text in DB (content is all we need for chunking)
- [ ] All endpoints return consistent JSON shape via `lib/errors.py`
- [ ] OpenAPI docs available at `http://localhost:8010/docs`
- [ ] Unit tests: every endpoint, every validation rule, cascade behavior
- [ ] Integration tests: create course → add modules → add lessons → query → delete

## Blocked by

- P01 — needs `lib/db.py`, `lib/errors.py`
- P02 — needs schema tables (courses, modules, lessons, tags, course_tags)

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
