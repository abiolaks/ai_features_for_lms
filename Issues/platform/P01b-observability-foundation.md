# Platform Slice P01b: Observability Foundation (Phoenix + OpenTelemetry + Evals)

- **Type:** AFK
- **Blocked by:** P01 (needs Docker Compose + `lib/` structure)
- **User stories covered:** (infrastructure — measurement across all platform + AI slices)

## What to build

A comprehensive observability foundation that every service — platform and AI — inherits. Three layers:

1. **OpenTelemetry tracing** — distributed traces across all services
2. **Arize Phoenix** — local UI for trace visualization, span inspection, and eval scoring
3. **OpenInference** — LLM-aware instrumentation that auto-captures prompts, responses, token counts, embeddings, and retrievals

This slice replaces the basic `lib/tracing.py` stub from P01 with a production-ready instrumentation layer.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Service (any)                                       │
│  ┌───────────────────────────────────────────────┐  │
│  │  lib/observability.py  ← every service calls  │  │
│  │  ├── init_tracing(service_name) → tracer      │  │
│  │  ├── @traced(name)          decorator         │  │
│  │  ├── trace_llm(...)         LLM span helper   │  │
│  │  ├── trace_retrieval(...)   RAG span helper   │  │
│  │  └── trace_embedding(...)   embedding helper  │  │
│  └───────────────────────────────────────────────┘  │
│         │ OTLP gRPC (port 4317)                      │
└─────────┼───────────────────────────────────────────┘
          ▼
┌─────────────────────────────────────────────────────┐
│  Phoenix (Docker)                                    │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │ OTLP Collector│  │  UI :6006    │                 │
│  │ (gRPC :4317) │  │              │                 │
│  └──────────────┘  └──────────────┘                 │
│  ┌──────────────────────────────────────────────┐   │
│  │  Evals (built-in)                             │   │
│  │  ├── Hallucination detection                  │   │
│  │  ├── QA correctness                           │   │
│  │  ├── Relevance scoring                        │   │
│  │  └── Custom eval templates                    │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## What goes in `lib/observability.py`

```python
# lib/observability.py
# Shared OpenTelemetry + OpenInference + Phoenix setup.
# Imported by every service. Sets up tracing, LLM spans, and eval hooks.

import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from openinference.instrumentation import using_attributes
from openinference.semconv.trace import (
    SpanAttributes,
    LLMRequestAttributes,
    LLMResponseAttributes,
)

PHOENIX_ENDPOINT = os.getenv("PHOENIX_ENDPOINT", "http://phoenix:4317")

# Global state — initialized once per service
_tracer = None

def init_tracing(service_name: str):
    """Initialize tracing for a service. Call once at startup."""
    global _tracer
    provider = TracerProvider()
    exporter = OTLPSpanExporter(endpoint=PHOENIX_ENDPOINT, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    _tracer = trace.get_tracer(service_name)
    return _tracer

def instrument_fastapi(app):
    """Auto-instrument FastAPI app. Adds spans for every request."""
    FastAPIInstrumentor.instrument_app(app)

def trace_llm(
    model_name: str,
    provider: str,
    tier: str,
    prompt: str,
    response: str,
    tokens_in: int,
    tokens_out: int,
    duration_ms: float,
    org_id: str = None,
):
    """Record an LLM call as a span. Call after every LLM invocation."""
    tracer = _tracer or trace.get_tracer(__name__)
    with tracer.start_as_current_span("llm.generate") as span:
        span.set_attribute(SpanAttributes.LLM_MODEL_NAME, model_name)
        span.set_attribute(SpanAttributes.LLM_PROVIDER, provider)
        span.set_attribute(LLMRequestAttributes.LLM_PROMPT_TEMPLATE, prompt[:2000])  # Truncate for storage
        span.set_attribute(LLMResponseAttributes.LLM_RESPONSE, response[:2000])
        span.set_attribute(SpanAttributes.LLM_TOKEN_COUNT_TOTAL, tokens_in + tokens_out)
        span.set_attribute(SpanAttributes.LLM_TOKEN_COUNT_PROMPT, tokens_in)
        span.set_attribute(SpanAttributes.LLM_TOKEN_COUNT_COMPLETION, tokens_out)
        span.set_attribute("llm.tier", tier)
        span.set_attribute("llm.duration_ms", duration_ms)
        if org_id:
            span.set_attribute("org.id", org_id)

def trace_retrieval(
    query: str,
    scope: str,
    num_chunks: int,
    top_score: float,
    duration_ms: float,
):
    """Record a RAG retrieval as a span."""
    tracer = _tracer or trace.get_tracer(__name__)
    with tracer.start_as_current_span("retrieval.search") as span:
        span.set_attribute("retrieval.query", query[:500])
        span.set_attribute("retrieval.scope", scope)
        span.set_attribute("retrieval.num_chunks", num_chunks)
        span.set_attribute("retrieval.top_score", top_score)
        span.set_attribute("retrieval.duration_ms", duration_ms)

def trace_embedding(
    model: str,
    num_texts: int,
    duration_ms: float,
):
    """Record embedding generation as a span."""
    tracer = _tracer or trace.get_tracer(__name__)
    with tracer.start_as_current_span("embedding.generate") as span:
        span.set_attribute("embedding.model", model)
        span.set_attribute("embedding.num_texts", num_texts)
        span.set_attribute("embedding.duration_ms", duration_ms)

def traced(name: str = None):
    """Decorator: wraps a function in a span. Use for key business logic."""
    def decorator(func):
        span_name = name or func.__name__
        async def wrapper(*args, **kwargs):
            tracer = _tracer or trace.get_tracer(__name__)
            with tracer.start_as_current_span(span_name) as span:
                result = await func(*args, **kwargs)
                return result
        return wrapper
    return decorator
```

## How services use it (3 lines per service)

```python
# services/tutor/main.py
from lib.observability import init_tracing, instrument_fastapi

app = FastAPI()
init_tracing("tutor")
instrument_fastapi(app)  # Auto-spans for every HTTP request

@app.post("/tutor/ask")
async def ask(req: AskRequest):
    # ... retrieve chunks ...
    trace_retrieval(
        query=req.question,
        scope="lesson",
        num_chunks=len(chunks),
        top_score=chunks[0].score if chunks else 0,
        duration_ms=(time.time() - start) * 1000,
    )
    # ... call LLM ...
    trace_llm(
        model_name="llama3.2",
        provider="ollama",
        tier="standard",
        prompt=prompt,
        response=answer,
        tokens_in=token_count,
        tokens_out=response_tokens,
        duration_ms=llm_duration_ms,
        org_id=req.org_id,
    )
```

## Phoenix Evals

Evals run inside Phoenix against stored traces. Two modes:

### Built-in evals (zero config)

Phoenix ships with eval templates accessible from the UI:
- **Hallucination** — does the LLM response contradict the retrieved context?
- **QA Correctness** — does the answer match expected output?
- **Relevance** — are retrieved chunks relevant to the query?
- **Toxicity** — is the response appropriate?

These run on-demand by selecting spans in the Phoenix UI and clicking "Run Evaluation."

### Automated eval datasets (`lib/evals.py`)

We define eval datasets as code so they run in CI:

```python
# lib/evals.py — stored alongside observability.py
# Eval datasets that run against Phoenix traces in CI.

EVAL_DATASETS = {
    "tutor_groundedness": [
        {
            "input": "What is a Python list comprehension?",
            "expected_output_contains": ["compact way", "create lists"],
            "must_not_contain": ["I don't know"],  # Should find this in MIT 6.0001 content
        },
        {
            "input": "Explain quantum entanglement",
            "expected_output_contains": ["not in this lesson"],  # Not in intro CS content
        },
    ],
    "insights_tone": [
        {
            "input_quiz_score": 25.0,
            "must_not_contain": ["disappointing", "failed", "poor", "terrible"],
            "must_contain": ["keep going", "review", "practice"],
        },
    ],
}
```

CI runs: `python -m lib.evals --dataset tutor_groundedness` → queries the running services → sends results to Phoenix → checks scores against thresholds.

### Eval CI workflow

```makefile
# Makefile additions
eval-tutor:
	python -m lib.evals --dataset tutor_groundedness --threshold 0.8

eval-all:
	python -m lib.evals --all
```

## Docker Compose (update P01's compose)

```yaml
phoenix:
  image: arizephoenix/phoenix:latest
  ports:
    - "6006:6006"   # UI
    - "4317:4317"   # OTLP gRPC collector
  environment:
    - PHOENIX_WORKING_DIR=/phoenix-data
  volumes:
    - ./data/phoenix:/phoenix-data  # Persist traces across restarts
```

## What you see in Phoenix

**Platform traces:**
- `GET /api/catalogue?difficulty=beginner` → content-service span: SQL query (12ms) → response serialization (2ms)
- `POST /api/quizzes/{id}/submit` → quiz-engine span: validate answers (5ms) → score calculation (1ms) → store results (8ms)

**AI traces (waterfall):**
- Tutor: `retrieval.search` (85ms) → `llm.generate` (1.2s) → `response.format` (3ms)
- Question Gen: `retrieval.search` (120ms) → `llm.generate` (2.3s — quality tier is slower)
- Insights: `llm.generate` (800ms — simple prompt, no retrieval needed)
- Degradation: spans show fast-fail path when gateway is down (2ms, no LLM call)

**Filtering:**
- By `org.id` → see token consumption per org
- By `llm.tier` → compare standard vs quality latency
- By error → find all failed requests across all services

## Acceptance criteria

- [ ] Phoenix UI accessible at `http://localhost:6006` with trace ingestion active
- [ ] `lib/observability.py` exports all helper functions: `init_tracing`, `instrument_fastapi`, `trace_llm`, `trace_retrieval`, `trace_embedding`, `traced`
- [ ] FastAPI instrumentation auto-creates spans for every HTTP request
- [ ] `trace_llm()` records model name, provider, tier, prompt (truncated), response (truncated), token counts, duration, org_id
- [ ] `trace_retrieval()` records query, scope, chunk count, top score, duration
- [ ] `trace_embedding()` records model, batch size, duration
- [ ] Every service imports and calls `init_tracing(service_name)` at startup (enforced by integration test)
- [ ] Traces from multiple services form a single distributed trace when requests chain (e.g., Tutor calls Gateway → RAG → LLM)
- [ ] `lib/evals.py` defines eval datasets for tutor_groundedness and insights_tone
- [ ] `make eval-tutor` runs groundedness eval and reports pass/fail
- [ ] Phoenix traces persist across Docker restarts (volume mount)
- [ ] CI smoke test: start services, make one request, verify trace appears in Phoenix
- [ ] Unit tests: mock OTLP exporter, verify span attributes are correctly set
- [ ] README section: how to view traces, how to run evals, how to interpret waterfall

## Blocked by

- P01 — needs Docker Compose structure and `lib/` directory

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
