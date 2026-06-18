# Agent Instructions — AI-Powered LMS

## Project Context

This project builds a complete Learning Management Platform from scratch — the LMS itself first, then an AI layer on top. Everything runs locally with open-source tools. Zero cloud dependencies. Zero API keys.

The LMS hosts free, high-quality courses from MIT OpenCourseWare, YouTube, and other open sources. Learners browse, enroll, track progress, and take quizzes. The AI layer adds a grounded tutor, personalized learning paths, recommendations, post-quiz insights, a platform assistant, AI-generated assessments, and quality checks.

Full context and implementation plan is in `Issues/`:
- `Issues/README.md` — structure, stack, wave order, PR checklist
- `Issues/TECH_PRINCIPLES.md` — open-source stack, code conventions, PR rules (READ THIS FIRST)
- `Issues/platform/` — 12 platform foundation slices (P00–P10)
- `Issues/ai/` — 16 AI feature slices (AI01–AI13)
- `docs/vertical-slices-phase-1.md` — original vertical slice definitions (pre-split)
- `docs/prd-ai-features-phase-1.md` — requirements, user stories, decisions

## Using opensrc for Deep Dependency Context

When building, implementing, or debugging, use `opensrc` to fetch and read the source code of dependencies instead of relying on documentation alone. The project uses open-source libraries exclusively — their source is the authoritative reference.

### Cached Dependencies

These packages have been pre-fetched and are available locally:

| Package | opensrc path | Used in |
|---------|-------------|---------|
| fastapi | `opensrc path pypi:fastapi` | Every service |
| pydantic | `opensrc path pypi:pydantic` | Request/response models |
| uvicorn | `opensrc path pypi:uvicorn` | ASGI server |
| sqlalchemy | `opensrc path pypi:sqlalchemy` | Database models (P02) |
| alembic | `opensrc path pypi:alembic` | Schema migrations (P02) |
| httpx | `opensrc path pypi:httpx` | Async HTTP client (P10 gateway, tests) |
| pytest | `opensrc path pypi:pytest` | All tests |

### When to Use opensrc

**Always fetch source before:**
- Wrapping an SDK or building adapters around a library
- Debugging unexpected library behaviour
- Understanding async patterns, retry logic, or configuration options
- Determining if a feature needs a workaround for library limitations
- Understanding Web Component lifecycle (for P00 UI components)

**How to use:**
```bash
# Fetch a package (if not already cached)
opensrc fetch pypi:package-name

# Get the path to cached source
opensrc path pypi:package-name

# Read the source
read $(opensrc path pypi:fastapi)/fastapi/applications.py
```

### Packages to Fetch When Needed

```bash
# Core stack
opensrc fetch pypi:lancedb                 # Vector database (AI slices)
opensrc fetch pypi:sentence-transformers   # Embeddings (AI01a, AI02, AI11)
opensrc fetch pypi:textstat                # Reading level estimation (AI11)
opensrc fetch pypi:cachetools              # In-memory LRU cache (AI07)

# Observability
opensrc fetch pypi:opentelemetry-api       # OTel SDK
opensrc fetch pypi:opentelemetry-sdk
opensrc fetch pypi:opentelemetry-exporter-otlp
opensrc fetch pypi:openinference-instrumentation  # LLM spans for Phoenix

# LLM
opensrc fetch pypi:tiktoken                # Token counting (AI01a, AI03)

# Content ingestion
opensrc fetch pypi:yt-dlp                  # YouTube playlist import (P04)
opensrc fetch pypi:beautifulsoup4          # HTML parsing for MIT OCW (P04)
opensrc fetch pypi:lxml                    # Fast HTML parser
opensrc fetch pypi:pyyaml                  # Manual course YAML (P04)

# Testing
opensrc fetch pypi:pytest-asyncio          # Async test support
opensrc fetch pypi:httpx                   # Async HTTP test client
```

## Key Architecture Decisions

### Platform (Issues/platform/)
- **Self-built LMS** — not bolting AI onto an existing platform. P01–P10 build the full platform: courses, learners, enrollments, quizzes, admin.
- **Monorepo** — one repo, many services. Shared `lib/` for DB, auth, tracing, observability, and UI components.
- **Single SQLite database** — one file, zero config. Same file shared across all services. Alembic migrations.
- **API key auth** — simple `X-API-Key` header. SHA-256 hashed in DB. No OAuth, no passwords.
- **Platform Gateway (P10)** — single port `8000`. Auth at the edge. Routes to all backend services.
- **Course content from open sources** — MIT OCW, YouTube playlists, manually-authored YAML. Importers in P04.

### AI Layer (Issues/ai/)
- **Single LLM Gateway (AI03)** — all AI services call it, never call Ollama directly. Wraps Ollama's HTTP API behind an adapter.
- **LanceDB for vector search** — embedded, no server, data stored as files. Used by chunking (AI01b) and retrieval (AI02).
- **Local embeddings** — `all-MiniLM-L6-v2` via sentence-transformers. 384-dim, runs on CPU. Used by chunking, retrieval, and duplicate detection.
- **Open-source LLMs via Ollama** — `llama3.2` for standard tier, `mistral` for quality tier. No API keys.
- **Org isolation** — enforced at the query level in LanceDB. Not in application code.
- **Phoenix observability (P01b)** — every LLM call, embedding, and retrieval is traced. Evals run in CI.

### UI (P00)
- **Web Components** — `<lms-card>`, `<lms-tabs>`, `<lms-table>`, etc. Shadow DOM. Zero framework dependencies.
- **TypeScript** — compiled to ES modules with `tsc`. No bundler, no build step beyond type-checking.
- **CSS custom properties** — design tokens in `lib/ui/tokens/`. Responsive via CSS Grid `auto-fit`.
- **Style guide** — live at `localhost:8005`. Every component with copy-paste HTML snippets.

## Tech Stack

- **Language:** Python 3.11+ (backend), TypeScript (frontend)
- **Web framework:** FastAPI + uvicorn
- **Database:** SQLite via SQLAlchemy + Alembic
- **Vector DB:** LanceDB (embedded)
- **LLM:** Ollama (llama3.2, mistral)
- **Embeddings:** sentence-transformers (all-MiniLM-L6-v2)
- **Cache:** cachetools (in-memory LRU)
- **Observability:** OpenTelemetry + Arize Phoenix + OpenInference
- **Content ingestion:** yt-dlp, BeautifulSoup4, PyYAML
- **Reading level:** textstat
- **Token counting:** tiktoken
- **Testing:** pytest + httpx
- **Frontend:** Web Components + TypeScript + CSS custom properties

## Service Port Map

| Port | Service | Slice |
|------|---------|-------|
| 8000 | Platform Gateway | P10 |
| 6006 | Phoenix UI | P01b |
| 4317 | Phoenix OTLP collector | P01b |
| 8002 | Demo Dashboard | AI13 |
| 8005 | Style Guide | P00 |
| 8010 | Content Management | P03 |
| 8011 | Learner Accounts | P05 |
| 8012 | Course Catalogue | P06 |
| 8013 | Enrollment & Progress | P07 |
| 8014 | Quiz Engine | P08 |
| 8015 | Admin Dashboard | P09 |
| 10000 | Azurite (Blob emulator) | P01 |
