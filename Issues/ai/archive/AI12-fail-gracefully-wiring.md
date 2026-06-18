# Slice 12: Fail Gracefully Wiring

- **Type:** AFK
- **Blocked by (internal):** Slice 0, Slice 4a, Slice 4b, Slice 6, Slice 7, Slice 8, Slice 9, Slice 10b
- **Blocked by (external):** None (UI surfaces are platform team scope — this slice provides the response signals)
- **User stories covered:** 38, 39

## Parent

`docs/vertical-slices-phase-1.md` — Slice 12: Fail Gracefully Wiring

## What to build

Unified degradation behavior across all AI features. When AI is unavailable (LLM Gateway down, provider errors, budget exhausted), every feature responds with a consistent degradation signal instead of crashing or timing out.

**This is wiring work** — each feature service already exists. This slice adds try/catch wrappers and response decorators to each, plus a shared health-check pattern.

**Degradation categories:**

| Feature type | Services | Degradation behavior |
|-------------|----------|---------------------|
| **Inline** | Tutor (4a, 4b), Assessment Gen (10a, 10b) | Response includes `ai_status: "degraded"`. Triggers amber dismissible banner + disabled trigger buttons with tooltip (signal for UI team). |
| **Enrichment** | Learning Paths (6), Insights (8) | AI-generated content replaced with placeholders. Non-AI content still served. Paths return course list without explanations; Insights return empty with placeholder message. |
| **Recommendations** | Course Recommendations (7) | Triggers built-in fallback cascade (already implemented in Slice 7). No additional work needed. |
| **Navigation** | Platform Assistant (9) | Response includes `ai_status: "degraded"`. Widget greys out with tooltip (signal for UI team). |

**Shared degradation signal:**

Every AI-dependent endpoint response includes:
```json
{
  "ai_status": "available" | "degraded",
  ...service-specific fields
}
```

A shared health-check module (imported by all services) probes the LLM Gateway periodically (`GET /health` on Slice 3) and caches the status. When the gateway is down, all services short-circuit their AI calls and return the degraded response immediately — no waiting for timeouts. All degradation events logged via OpenTelemetry to stdout. See `Issues/TECH_PRINCIPLES.md`.

**Budget-exhaustion detection:** Already handled by Slice 3 (returns 429). Services catch 429 from the gateway and treat it identically to gateway-down.

## Acceptance criteria

- [ ] Slice 3 down → Tutor returns `ai_status: "degraded"`, no crash, no timeout
- [ ] Slice 3 down → Learning Paths return course list without `why_this_fits` explanations, `ai_status: "degraded"`
- [ ] Slice 3 down → Insights return placeholder message ("Insights unavailable right now"), `ai_status: "degraded"`
- [ ] Slice 3 down → Recommendations fall back to rule-based cascade (Slice 7 handles this), `ai_status: "degraded"`
- [ ] Slice 3 down → Platform Assistant returns `ai_status: "degraded"`, no crash
- [ ] Slice 3 budget exhausted (429) → same degradation as gateway down across all services
- [ ] Health check cache prevents cascading timeouts (services fail fast, don't wait for gateway timeout)
- [ ] All degraded responses include `ai_status: "degraded"` (never missing or inconsistent)
- [ ] Slice 3 recovers → next health check detects it, `ai_status: "available"` resumes on next request
- [ ] Non-AI endpoints (e.g., Profile CRUD) never return `ai_status: "degraded"` — only AI-dependent endpoints
- [ ] Unit tests: degradation signal generation per service, health check cache TTL, 429 handling
- [ ] Unit tests: verify mock responses match degraded contract (field presence, correct status values)
- [ ] Integration tests: kill Slice 3 → call every feature endpoint → verify all return `ai_status: "degraded"` with correct degraded payloads → restore Slice 3 → verify recovery

## Blocked by

- Slice 0 (mock platform)
- Slice 4a, 4b (Tutor Core + History)
- Slice 6 (Personalized Learning Paths)
- Slice 7 (Course Recommendations)
- Slice 8 (Post-Activity Insights)
- Slice 9 (Platform Assistant)
- Slice 10b (Assessment Approval Workflow)
