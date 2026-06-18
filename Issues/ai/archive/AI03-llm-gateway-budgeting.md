# Slice 3: LLM Gateway + Usage Budgeting

- **Type:** AFK
- **Blocked by (internal):** Slice 0 (for mock org budget caps)
- **Blocked by (external):** None (uses mock LLM provider / mock org config)
- **User stories covered:** 36, 37

## Parent

`docs/vertical-slices-phase-1.md` — Slice 3: LLM Gateway + Usage Budgeting

## What to build

A single entry point for all LLM calls across every AI feature service. Exposes one endpoint:

`POST /generate` — body: `{prompt, tier: "standard"|"quality", org_id}`

**Behavior:**

- `tier=standard` → routes to fast model (`llama3.2` via Ollama, or mock)
- `tier=quality` → routes to capable model (`mistral` or `llama3.1:8b` via Ollama, or mock)
- Token consumption tracked per org, cumulative within the billing period
- **Soft throttle at 80%** of monthly cap → response includes `throttle_warning: true` but still processes
- **Hard stop at 100%** → response returns 429 with `{error: "budget_exhausted", message: "Contact your org admin..."}`
- Token counters reset at billing period boundary (configurable via env: `BILLING_PERIOD_DAYS`)
- Provider outage (timeout, 5xx) → gateway returns 502, does not crash

**Mock mode:** When `LLM_PROVIDER=mock`, the gateway echoes the prompt back with a fake response and synthetic token count — enabling all downstream slices to test without a running Ollama instance.

**Tech note:** Ollama's HTTP API (`POST /api/chat` and `/api/generate`) has the same shape as OpenAI's chat completions endpoint. The gateway wraps Ollama behind a `ports.py` adapter, so swapping to any cloud LLM later requires changing one adapter. See `Issues/TECH_PRINCIPLES.md` for the open-source stack.

## Acceptance criteria

- [ ] POST /generate with tier=standard → routes to fast model, returns response with token count
- [ ] POST /generate with tier=quality → routes to capable model, returns response with token count
- [ ] Token consumption tracked per org, cumulative within billing period
- [ ] Org hits 80% cap → response includes `throttle_warning: true`, request still processed
- [ ] Org hits 100% cap → request rejected with 429, admin-directed message in body
- [ ] Token counters reset after billing period boundary
- [ ] `LLM_PROVIDER=mock` → gateway returns fake responses with synthetic token counts
- [ ] Provider timeout → gateway returns 502 with error payload, does not crash
- [ ] Provider 5xx → gateway returns 502, does not crash
- [ ] Concurrent requests from same org → token counting is accurate (no race conditions)
- [ ] Unit tests: tier routing logic, token counter arithmetic, budget state transitions
- [ ] Unit tests: throttle (80%) vs hard-stop (100%) boundary conditions
- [ ] Integration tests: end-to-end prompt → response through local Ollama with budget tracking
- [ ] Integration tests: `LLM_PROVIDER=mock` mode works for CI without Ollama installed

## Blocked by

- Slice 0 (mock org config with budget caps)

See `Issues/TECH_PRINCIPLES.md` for open-source stack details.
