# Part 12: Deep vs Shallow Module Analysis

Using the vocabulary from _A Philosophy of Software Design_ (Ousterhout):

- **Depth** = how much behavior sits behind how small an interface
- **Deep module** = small interface + lots of implementation (good)
- **Shallow module** = large interface + thin implementation (bad)
- **Test**: delete the module — if complexity reappears across N callers, it was deep. If nothing changes, it was a pass-through.

---

## Shared Modules (9 total)

### 1. `observability.ts` — ⚠️ Shallow

```
Interface: startSpan(name), setAttr(ctx, k, v), endSpan(ctx)
           + SpanContext type (4 fields)

Implementation: ~25 lines.
  - startSpan → { name, attrs: {}, startMs: Date.now() }
  - setAttr   → ctx.attrs[key] = value
  - endSpan   → console.log(JSON.stringify({span, duration_ms, ...attrs}))

Depth: LOW. Interface IS the implementation.
```

**Why shallow:** Three functions that are each 1-3 lines. The caller does all the work — calling `setAttr` repeatedly, remembering to call `endSpan` on every code path, wrapping in try/catch. There's no hidden complexity.

**Deepening opportunity:** A single `withSpan(name, attrs, fn)` wrapper that auto-closes the span (including on errors):

```typescript
// Current (caller burden):
const span = startSpan("tutor.ask");
try { ... setAttr(span, ...); endSpan(span); }
catch (e) { setAttr(span, "error", e.message); endSpan(span); }

// Deeper alternative:
await withSpan("tutor.ask", { org_id }, async (span) => {
  span.set("citations", 5);
  // auto-closes on return or throw
});
```

Currently 13 workers each contain ~20+ span-related lines that could collapse to one call. But the current design was chosen intentionally — Cloudflare Workers capture top-level spans automatically, these are custom sub-spans, and the explicit pattern makes error paths visible.

---

### 2. `cors.ts` — ✅ Moderately Deep

```
Interface: corsHeadersFor(origin?), json(data, status?, origin?), handleCors(req)
           + ALLOWED_ORIGINS constant

Implementation: ~65 lines.
  - Origin whitelist matching with fallback
  - CORS header construction (Allow-Origin, Allow-Methods, Allow-Headers, Max-Age)
  - JSON serialization + CORS headers in one call
  - OPTIONS preflight detection + 204 response

Depth: MEDIUM. 3 functions hide origin validation, header construction, and preflight.
```

**What callers DON'T need to know:**
- The whitelist of 6 origins
- That credentialed requests require echoed origin (not `*`)
- The 4 CORS headers needed
- That OPTIONS returns 204 (not 200)

**Test:** Delete `cors.ts`. Every worker would need 20+ lines of CORS boilerplate. 13 workers × 20 lines = 260 lines of duplication. **This module earns its keep.**

---

### 3. `gateway.ts` — ✅ Deep

```
Interface: callGateway(gateway, prompt, orgId, tier?)
           + GatewayResult type

Implementation: ~45 lines.
  - Constructs Request to internal service binding
  - Sends POST /generate with { messages, tier, org_id }
  - Parses JSON response
  - Extracts and normalizes response/model/tokens fields
  - Returns null on any failure (fetch error, non-ok, parse error)
  - Collapses 5 failure modes into one null return

Depth: HIGH. 1 function hides fetch, parse, normalize, and error collapse.
```

**Test:** Delete `gateway.ts`. Every worker would need to construct the gateway Request, parse the response, handle 5 error modes. 12 workers × 15 lines = 180 lines of duplication. **Deep.**

---

### 4. `fetch-lms.ts` — ✅ Deep

```
Interface: fetchLms(env, options), fetchLmsResource<T>(env, path)

Implementation: ~60 lines.
  - Auto-detects auth: JWT (Bearer) vs API Key (X-API-Key)
  - URL construction from LMS_GATEWAY_URL + path
  - Response.ok logging
  - fetchLmsResource<T>: unwraps { data } envelope, returns typed T | null
  - All errors collapsed to null

Depth: HIGH. 2 functions hide auth detection, URL construction, envelope unwrapping, typed generics.
```

**Test:** Delete `fetch-lms.ts`. Every worker would duplicate auth detection logic and response unwrapping. 10 workers consuming LMS endpoints × 10 lines = 100 lines. **Deep.**

The `fetchLmsResource<T>` generic is the deepest single function in the codebase — it combines auth, fetch, parse, envelope unwrap, type casting, and null-on-failure into one call.

---

### 5. `lms-data.ts` — ✅ Very Deep

```
Interface: fetchProfile(env, stub?, learnerId?), fetchCatalog(env, orgId, stub?),
           fetchProgress(env, learnerId, stub?)
           + 4 types (LearnerProfile, CatalogueCourse, ProgressEntry, LmsEnv)

Implementation: ~120 lines.
  Each function:
    1. Try LMS → map fields from LMS response shape to internal type
    2. Profile: extract gamification.* fields (login_streak, total_points)
    3. Catalog: if authenticated empty → try public /api/v1/public/courses
    4. Progress: extract enrollments[], map status/progress_pct
    5. If LMS fails or returns empty → return the stub
    6. All return { data, fromLms: boolean } for degraded mode awareness

Depth: VERY HIGH. 3 functions hide 2-tier LMS fallback, field mapping, and degraded mode.
```

**Test:** Delete `lms-data.ts`. Every worker needing LMS data would duplicate the try→map→stub-fallback pattern, the catalog double-fetch, and the gamification field extraction. 4 workers use this × 30 lines = 120 lines. **Very deep.**

The catalog's dual-endpoint pattern (authenticated → public fallback) is a particularly good example of hidden complexity — callers never know it happens.

---

### 6. `llm-parser.ts` — ✅ Very Deep

```
Interface: parseLlmJson<T>(response: string): T | null
           (private: balanceBraces)

Implementation: ~75 lines.
  - Extracts ```json code blocks
  - Extracts bare { } or [ ] from text with leading/trailing noise
  - Prefers longer match when both array and object present
  - Handles truncated JSON: counts braces, adds missing closes
  - Collapses all failure modes to null

Depth: VERY HIGH. One function hides 4 parsing strategies + brace balancing.
```

**Test:** Delete `llm-parser.ts`. Workers would need ad-hoc JSON extraction with markdown stripping and truncation handling. Every worker that calls the gateway would duplicate this. 8+ workers × 20 lines = 160 lines. **Very deep.**

---

### 7. `sanitize.ts` — ⚠️ Shallow (Intentionally)

```
Interface: sanitize(text, maxLength?)

Implementation: ~15 lines.
  - Null/undefined → ""
  - Strip quotes, trim, cap

Depth: LOW. The implementation IS the interface.
```

**Why shallow is OK here:** It's a consistency utility. The value isn't hiding complexity — it's **preventing drift**. Without it, different workers would use slightly different cleaning logic. 8+ workers use this, and they all get the same behavior. Shallow but justified.

---

### 8. `test-utils.ts` — ⚠️ Shallow (Intentionally)

```
Interface: createMockGateway(response, ok?), createLlmResponse(payload),
           spyOnSpans()

Implementation: ~55 lines across 3 functions.
  - createMockGateway: vi.fn → resolves to new Response(JSON.stringify(...))
  - createLlmResponse: wraps payload in standard gateway response shape
  - spyOnSpans: vi.spyOn(console.log) + filter helper

Depth: LOW. All three are thin wrappers.
```

**Why shallow is OK here:** Test utilities are supposed to be shallow. They standardize mock shapes across 13 test suites. The value is **interface consistency**, not implementation depth. Every test suite imports these instead of copy-pasting `vi.fn().mockResolvedValue(new Response(...))`.

---

### 9. `env.ts` + `types.ts` — N/A (Type Definitions)

Pure type declarations. Not modules in the Ousterhout sense — they have interface but no implementation. Their value is centralizing contracts.

---

## Worker Modules

### TutorSession DO (`TutorSession.ts`) — ✅ Very Deep

```
Interface (3 public methods):
  ask(body: AskRequest): Promise<Response>
  clearHistory(origin?: string): Promise<Response>
  fetch(req: Request): Promise<Response>        // WebSocket upgrade

Implementation: ~450 lines.
  Hidden behind ask():
    - Embed question → bge-large-en-v1.5 (1024-dim)
    - Vectorize query with scope filtering (lesson/module/course)
    - TOP_K=50 → filter by score+scope → dedupe to 15
    - Prompt construction: [rules] + [history] + [content] + [question]
    - Gateway call → parse response
    - Save exchange to SQLite (INSERT user + assistant, prune to 20)
    - Return { answer, citations, scope_expansion_suggested, history_length }

  Hidden behind fetch()/webSocketMessage():
    - WebSocket upgrade + pairing
    - Streaming ask: citations first, then tokens via SSE forwarding
    - Voice ask: STT (Whisper) → error correction (LLM) → streaming ask → TTS (melotts)
    - TTS: base64 decode → chunk to 4KB → stream audio chunks
    - Markdown cleaning for TTS (strip bold, italic, code, headings, lists)

  Hidden behind all methods:
    - SQLite schema management (CREATE TABLE IF NOT EXISTS)
    - History loading (last 20, reversed)
    - Persona configuration (name, voice, tone profile)
    - Interaction mode selection

Depth: VERY HIGH. 3 public methods hide ~450 lines across 8+ subsystems.
```

**Test:** Delete `TutorSession.ts`. You'd need to rebuild: embedding, Vectorize querying, prompt construction, gateway integration, history management, WebSocket streaming, voice pipeline, TTS generation. **Extremely deep.**

---

### AssistantSession DO (`AssistantSession.ts`) — ✅ Very Deep

```
Interface (2 public methods):
  ask(body: AskRequest): Promise<Response>
  clearHistory(origin?: string): Promise<Response>

Implementation: ~350 lines.
  Hidden behind ask():
    - Embed question → Vectorize (org-scoped, no lesson filter, TOP_K=30)
    - Score threshold 0.05 → filter by org_id → dedupe to 15
    - Fetch catalogue from LMS (dual-endpoint: auth → public fallback)
    - Build prompt: [rules] + [catalogue] + [history] + [content] + [question]
    - Gateway call → parse response
    - Parse "### Suggested Courses" section from LLM output
    - Pattern matching: [Title [course: id]] or Title — reason or Title: reason
    - Catalogue matching (case-insensitive, partial)
    - Keyword fallback when no structured section found
    - Degraded course suggestions from citations when gateway down
    - Save exchange to SQLite
    - Return { answer, citations, suggested_courses, history_length }

Depth: VERY HIGH. 2 public methods (smaller interface than Tutor) hide ~350 lines.
```

**Test:** Delete `AssistantSession.ts`. Rebuilding requires: org-scoped retrieval, catalogue-aware prompts, course suggestion parsing with 3 fallback strategies, degraded suggestions. **Very deep.**

---

### ai-gateway (`index.ts`) — ✅ Deep

```
Interface (4 endpoints):
  GET  /health?org_id=     → { models[], budget }
  GET  /budget?org_id=     → { monthly_cap, used, remaining }
  POST /generate           → { response, model_used, tokens_used, throttle_warning }
  POST /stream             → SSE: { type: "token"|"done" }

Implementation: ~200 lines.
  Hidden behind POST /generate:
    - Input validation (messages, tier, org_id)
    - Budget check: ensureBudget (INSERT OR IGNORE), getBudget (SELECT), exhaustion check (429)
    - Model selection: standard → llama-3.2-3b, quality → mistral-7b
    - Token limit: standard 1024, quality 2048
    - env.AI.run(model, { messages, max_tokens })
    - Token tracking: UPDATE org_budgets SET tokens_used += N
    - Throttle warning computation

  Hidden behind POST /stream:
    - Same as generate but stream: true
    - Workers AI SSE → tee() → side-reader accumulates + transformer reformats
    - Our SSE format: { type: "token", text: "..." } + { type: "done", response, tokens_used }
    - Token tracking after stream completes (in flush callback)

  Hidden behind GET endpoints:
    - D1 query for budget status
    - Model list + budget details

Depth: HIGH. 4 endpoints hide model selection, budget tracking, streaming pipeline, and token accounting.
```

**Test:** Delete `ai-gateway`. Every worker would need model selection, budget tracking, and streaming logic inline. 12 workers × the complexity = massive duplication. **Deep.**

---

### ai-indexing (`index.ts`) — ⚠️ Mixed: Shallow Interface, Deep Implementation

```
Interface (11 endpoints + queue consumer):
  POST /index, /extract-pdf, /deindex, /backfill
  GET  /status, /videos, /captions/:id, /diag-index/:id, /diag-deindex/:id,
       /diag-text, /diag-extract, /r2-list, /env-check

Implementation: ~500 lines.
  Hidden behind Queue consumer:
    - Video: VTT extraction → Stream captions (existing or AI-generated)
    - PDF: unpdf extraction (per-page)
    - PPTX: ZIP → XML → <a:t> text extraction
    - Text: UTF-8 decode
    - Chunking: ~2000 chars, sentence boundaries
    - Embedding: bge-large-en-v1.5 (1024-dim)
    - Vectorize: batch upsert (10 at a time)
    - Old vector cleanup before re-index

  Hidden behind POST /deindex:
    - Batch getByIds (20 per batch, 3 batches)
    - Delete all found vectors

Depth: INTERFACE IS TOO LARGE. 11 endpoints for what should be 4 (index, deindex, extract-pdf, status).
       The 7 diagnostic GET endpoints are development scaffolding that inflate the interface.
       The real implementation (queue consumer) is deep.
```

**Deepening opportunity:** Move diagnostic endpoints to a separate worker or behind a feature flag. Production interface should be POST /index, POST /deindex, POST /extract-pdf, GET /status — 4 endpoints hiding 500 lines of implementation.

---

### Remaining Workers (ai-paths, ai-recommendations, ai-insights, ai-mentor, ai-bottlenecks, ai-engagement, ai-analytics, ai-question-gen, ai-quality)

Each has a **single endpoint** (or 2), moderate implementation (150-400 lines), and follows the same pattern:

```
Interface: POST /worker/action { ...request body... }
Implementation: fetch LMS data → build prompt → call gateway → parse → return

Depth: MODERATE. 1 endpoint hides ~200 lines of data fetching + prompt building + parsing.
```

These are **pipeline modules** — they connect data sources to the gateway. They're not as deep as the DOs (which manage state) or the gateway (which manages model selection and budgeting), but they're not shallow either. Each one replaces what would be 50+ lines of ad-hoc data fetching + prompt construction in the LMS frontend.

---

## Depth Summary Table

| Module | Interface Size | Implementation | Depth | Notes |
|--------|---------------|----------------|-------|-------|
| `observability.ts` | 3 functions | ~25 lines | **Shallow** | Interface ≈ implementation |
| `cors.ts` | 3 functions | ~65 lines | **Moderate** | Saves 260 lines across 13 workers |
| `gateway.ts` | 1 function | ~45 lines | **Deep** | Saves 180 lines, 5 error modes collapsed |
| `fetch-lms.ts` | 2 functions | ~60 lines | **Deep** | Auth detection + envelope unwrap |
| `lms-data.ts` | 3 functions | ~120 lines | **Very Deep** | 2-tier fallback, field mapping, stub pattern |
| `llm-parser.ts` | 1 function | ~75 lines | **Very Deep** | 4 parsing strategies + truncation recovery |
| `sanitize.ts` | 1 function | ~15 lines | **Shallow** | Intentional — consistency, not complexity |
| `test-utils.ts` | 3 functions | ~55 lines | **Shallow** | Intentional — mock standardization |
| `TutorSession.ts` | 3 methods | ~450 lines | **Very Deep** | 8 subsystems behind 3 methods |
| `AssistantSession.ts` | 2 methods | ~350 lines | **Very Deep** | Retrieval + catalogue + suggestions |
| `ai-gateway` | 4 endpoints | ~200 lines | **Deep** | Budget, tier, streaming behind 4 endpoints |
| `ai-indexing` | 11 endpoints | ~500 lines | **Mixed** | Deep impl, bloated interface (7 diag routes) |
| Other workers | 1-2 endpoints | 150-400 lines | **Moderate** | Pipeline modules, predictable pattern |

---

## Overall Assessment

**The codebase favors depth where it matters:**

- The **3 deepest modules** (`TutorSession`, `AssistantSession`, `ai-gateway`) are the ones that would be most expensive to replace — they hide multi-subsystem complexity behind tiny interfaces.
- The **shared data modules** (`lms-data`, `llm-parser`, `gateway`, `fetch-lms`) are properly deep — each collapses multiple failure modes and complex parsing into a single call.
- **Intentional shallowness** appears where consistency matters more than hiding complexity (`sanitize`, `test-utils`).

**Areas where depth could improve:**

1. `observability.ts` — a `withSpan()` wrapper would collapse 5-10 lines per usage into 1
2. `ai-indexing` — 7 diagnostic routes should move out of the production interface
3. The 13 fetch-handler `index.ts` files are structurally shallow (thin routing wrappers), but that's by design — the depth lives in the DOs and shared modules they delegate to.
