# Platform Slice P01: Project Scaffold

- **Type:** AFK
- **Blocked by:** None — can start immediately
- **User stories covered:** (infrastructure — foundation for all slices)

## What to build

The monorepo skeleton that every other slice plugs into. This is the first PR — nothing else can start until this lands.

### Directory structure

```
lms/
├── docker-compose.yml          # Every service + Phoenix + Azurite
├── Makefile                    # make up, make test, make migrate, make reset
├── pyproject.toml              # Shared dependencies (FastAPI, SQLAlchemy, etc.)
├── lib/
│   ├── __init__.py
│   ├── tracing.py              # Shared OTel init (all services use this)
│   ├── db.py                   # SQLAlchemy engine + session factory
│   ├── auth.py                 # API key validation middleware
│   ├── config.py               # Env var loader with defaults
│   └── errors.py               # Shared HTTP error types + handlers
├── services/
│   └── .gitkeep                # Each slice adds a folder here
├── dashboard/
│   ├── index.html              # Shell (starts empty, cards added per slice)
│   └── style.css               # Minimal styling
├── data/                       # Gitignored — runtime data
│   ├── blobs/                  # Content files (raw/, indexing/)
│   ├── lancedb/                # Vector DB files
│   └── sqlite/                 # SQLite databases
└── tests/
    └── conftest.py             # Shared fixtures (Docker health check, test client)
```

### Docker Compose

Starts with services that everything depends on. Grows as slices ship.

```yaml
services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    ports: ["10000:10000"]
    volumes: ["./data/blobs:/data"]

  # Phoenix UI + OTLP collector (wired by P01b)
  # phoenix:
  #   image: arizephoenix/phoenix:latest
  #   ports: ["6006:6006", "4317:4317"]
```

### Shared library (`lib/`)

- **`tracing.py`** — Stub that imports from `lib/observability.py` (P01b replaces this with full Phoenix + OpenInference setup).
- **`db.py`** — `get_db()` → yields SQLAlchemy session. `run_migrations()` for Alembic.
- **`auth.py`** — `require_learner` dependency. Reads `X-API-Key` header, validates against DB.
- **`config.py`** — `from_env()` loads all config with defaults. One place for all env vars.
- **`errors.py`** — `AppError`, `NotFoundError`, `ValidationError` with consistent JSON shape.

Every service `pip install -e ..` from the monorepo root to get `lib/`.

### Makefile

| Command | Does |
|---------|------|
| `make up` | `docker compose up -d` |
| `make down` | `docker compose down -v` |
| `make migrate` | Run Alembic migrations on SQLite |
| `make test` | `pytest tests/` |
| `make reset` | Wipe `data/`, re-run migrations |

## Acceptance criteria

- [ ] `make up` starts Azurite + Phoenix with zero errors
- [ ] `lib/tracing.py` stub exists (full instrumentation wired by P01b)
- [ ] `lib/observability.py` skeleton created (imported by services, implementation in P01b)
- [ ] `lib/db.py` creates SQLite database in `data/sqlite/` on first connect
- [ ] `lib/auth.py` middleware extracts API key from header, rejects missing/invalid keys
- [ ] `lib/config.py` loads env vars with sensible defaults; missing required vars → clear error
- [ ] `lib/errors.py` exception handlers produce consistent JSON: `{"error": "type", "message": "..."}`
- [ ] `make test` runs pytest (zero tests at this point, but the harness works)
- [ ] `.gitignore` covers `data/`, `__pycache__/`, `.env`, `*.pyc`
- [ ] README.md at repo root: how to start, how to add a service, conventions
- [ ] All Python files have module-level docstrings

## Blocked by

None — can start immediately.

P00 (UI Foundation) runs in parallel with this slice. Both are Wave 1.

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
