# Platform Slice P04: Content Ingestion

- **Type:** AFK
- **Blocked by:** P03 (needs Content Management API)
- **User stories covered:** Platform — populate courses from free online sources

## What to build

Importers that fetch content from free course sources and populate the Content Management API (P03). One importer per source. Each importer is a standalone script — no HTTP endpoint, no schedule. Run manually or via `make ingest-{source}`.

### Source 1: MIT OpenCourseWare

**URL pattern:** `https://ocw.mit.edu/courses/{department}/{course-number}/`

MIT OCW is HTML pages with consistent structure. The importer:
1. Fetches the course homepage → extracts title, description, syllabus sections
2. Fetches each lecture page → extracts lecture title, transcript/video link, readings
3. Maps to our schema: Course → Module (topic sections) → Lesson (lectures)
4. Sets `source: "mit_ocw"`, `source_url` to the MIT page, `difficulty` inferred from course number (1xx = beginner, 2xx = intermediate, 3xx+ = advanced)
5. Tags: auto-extract from course metadata (department name, topics list)

**Initial set:** 5 courses across CS, math, and physics (e.g., 6.0001, 6.006, 18.01, 18.06, 8.01).

### Source 2: YouTube Playlists

**URL pattern:** `https://www.youtube.com/playlist?list={playlist_id}`

Uses `yt-dlp` (open-source Python library) to:
1. Fetch playlist metadata → title, description → becomes course
2. Fetch each video → title, description, auto-generated captions (transcript) → becomes lesson
3. Captions stored in `lessons.content` with `content_type: "video_transcript"`
4. `video_url` set to the YouTube URL, `duration_minutes` from video metadata
5. Tags: manually specified in an `ingest_config.yaml` per playlist

### Source 3: Manual Content

A JSON/YAML file format for hand-authoring courses:

```yaml
# data/ingest/manual/python-basics.yaml
course:
  title: "Python Basics"
  description: "Introduction to Python programming"
  difficulty: beginner
  source: manual
  estimated_hours: 20
  tags: [python, programming, beginner]
modules:
  - title: "Getting Started"
    lessons:
      - title: "Installing Python"
        content: "Python can be installed from python.org..."
      - title: "Your First Program"
        content: "Open your editor and type: print('hello world')..."
```

### Script structure

```
services/ingestion/
├── main.py              # CLI entry point: python -m ingestion --source mit_ocw
├── importers/
│   ├── __init__.py
│   ├── base.py          # BaseImporter class with common logic
│   ├── mit_ocw.py       # MIT OCW scraper
│   ├── youtube.py       # YouTube playlist importer
│   └── manual.py        # YAML file importer
├── config/
│   ├── mit_courses.yaml # Which MIT courses to import
│   └── playlists.yaml   # Which YouTube playlists to import
└── README.md            # How to add a new source
```

Importers call P03's HTTP API (`POST /courses`, `POST /courses/{id}/modules`, etc.) — they don't touch the DB directly. This keeps them decoupled and testable.

### Makefile additions

```makefile
ingest-mit:
	python -m services.ingestion --source mit_ocw

ingest-youtube:
	python -m services.ingestion --source youtube

ingest-manual:
	python -m services.ingestion --source manual
```

## Acceptance criteria

- [ ] `make ingest-mit` imports 5 MIT OCW courses with modules, lessons, and tags
- [ ] MIT course 6.0001 has correct title, description, and beginner difficulty
- [ ] MIT lecture pages produce lessons with content scraped from the page
- [ ] `make ingest-youtube` imports 2 playlists as courses with video transcript lessons
- [ ] YouTube lessons have `video_url` and `duration_minutes` set
- [ ] `make ingest-manual` imports courses from `data/ingest/manual/*.yaml`
- [ ] Re-running an importer is idempotent (doesn't create duplicates)
- [ ] Failed scrape logs error and continues to next item (doesn't crash the whole import)
- [ ] Each importer has a `--dry-run` flag that prints what it would do without calling P03
- [ ] `BaseImporter` class is reusable — adding a new source is ~50 lines of scrape logic
- [ ] Unit tests: each importer with mocked HTTP responses (or static HTML fixtures)
- [ ] Integration tests: run importer → query P03 endpoints → verify data landed correctly

## Blocked by

- P03 — needs Content Management API endpoints to post data into

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
