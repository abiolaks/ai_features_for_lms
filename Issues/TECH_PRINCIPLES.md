# Technology Principles — AI Features for LMS

Applies to all slices in this `Issues/` directory. Every slice inherits these constraints.

## Open-Source Stack (zero Azure dependency at code level)

| Concern | Open-Source Tool | Why |
|--------|-----------------|-----|
| **Vector DB** | [LanceDB](https://lancedb.github.io/lancedb/) | Embedded, no server, zero-config. Files stored alongside code. Swap to Qdrant for production later. |
| **LLM (local dev)** | [Ollama](https://ollama.com/) with open models | `llama3.2` for standard tier, `mistral` or `llama3.1:8b` for quality tier. No API keys. |
| **LLM (gateway)** | Slice 3 wraps Ollama's HTTP API (identical pattern to OpenAI — `/api/generate` and `/api/chat`) | Same interface shape, easy to swap to cloud later. |
| **Embeddings** | [sentence-transformers](https://www.sbert.net/) via `all-MiniLM-L6-v2` | 384-dim vectors, runs on CPU, ~80MB model. Used by chunking (AI01a), duplicate detection (AI11), and retrieval (AI02). Every embedding call traced via `trace_embedding()` → Phoenix. |
| **Blob Storage** | Local filesystem (`data/blobs/`) for dev, Azurite Docker container for CI | Structured directory mirrors production `raw/` and `indexing/` containers. |
| **Cache** | In-memory LRU cache ([`cachetools`](https://pypi.org/project/cachetools/)) | Zero infrastructure. Swap to Redis with one adapter later. |
| **Database** | SQLite via [sqlite-utils](https://sqlite-utils.datasette.io/) or raw `sqlite3` | File-based, no server. Simple schema, easy to inspect. Swap to PostgreSQL via same SQLAlchemy models later. |
| **Observability** | [OpenTelemetry](https://opentelemetry.io/) + [Arize Phoenix](https://phoenix.arize.com/) + [OpenInference](https://github.com/Arize-AI/openinference) | Distributed tracing across all services, LLM-aware spans (prompts, responses, tokens, embeddings), Phoenix UI at `:6006`, eval datasets for automated quality scoring. See P01b. |
| **Reading Level** | [`textstat`](https://pypi.org/project/textstat/) | Flesch-Kincaid grade estimation, pure Python, no API calls. |
| **HTTP Framework** | [FastAPI](https://fastapi.tiangolo.com/) + [uvicorn](https://www.uvicorn.org/) | Lightweight, typed, auto-docs at `/docs`. |
| **Testing** | [pytest](https://docs.pytest.org/) + [httpx](https://www.python-httpx.org/) | Async test client for HTTP services. |
| **Demo Dashboard** | Single HTML file + vanilla JS + FastAPI static mount | No framework, no build step. See Slice 13. |

## Code Principles

### Keep It Simple
- Prefer stdlib over dependencies. Every dependency must justify itself.
- One file per concern. If a file exceeds 300 lines, it's doing too much.
- Functions are short (≤30 lines). If longer, extract.
- No inheritance hierarchies. Composition and plain functions only.

### Comment Intent, Not Mechanics
```python
# GOOD: explains why
# We cache for 24h because the catalogue snapshot updates nightly,
# and re-fetching on every request would hammer the mock platform.
cache = TTLCache(maxsize=100, ttl=86400)

# BAD: explains what (the code already says this)
# Create a cache with 100 items and 86400 second TTL
cache = TTLCache(maxsize=100, ttl=86400)
```

Every module starts with a 2-4 line docstring describing what it does and which slice(s) own it.

### PR Size
- Target 200-400 lines per PR (including tests, config, comments).
- Hard ceiling: 500 lines. If approaching it, split the slice further.
- Reviewers should finish a PR in ≤20 minutes.

### No Cloud Lock-in
- All infrastructure is behind adapters (`StorageBackend`, `VectorStore`, `LLMProvider`, `CacheBackend`).
- The adapter interface is defined in a `ports.py` file in each service.
- Concrete implementations live in `adapters/` — one for local dev, one stub for future Azure.
- Environment variables switch adapters: `VECTOR_STORE=lance`, `LLM_PROVIDER=ollama`.

### Self-Sufficient Testing
- Every service starts and passes tests with `docker compose up -d && pytest`
- No cloud account required. No API keys. No network calls (all models run locally).
- Integration tests call real HTTP endpoints. Unit tests mock adapters at the port boundary.
- Traces visible in Phoenix at `http://localhost:6006` — every integration test run produces observable traces.
- Evals run against live traces: `make eval-all` scores groundedness, relevance, and tone across AI features.
