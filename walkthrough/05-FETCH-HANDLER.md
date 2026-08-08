# Part 5: Fetch Handler Pattern (index.ts)

Every worker's `src/index.ts` follows the same structure. Understanding one means understanding them all.

## The Template

```typescript
import { json, handleCors } from "../../shared/cors";
import { startSpan, setAttr, endSpan } from "../../shared/observability";
// + worker-specific imports (DO, gateway, lms-data, etc.)

export { WorkerSession };  // export DO class so wrangler can find it

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // 1. CORS preflight
    const preflight = handleCors(req);
    if (preflight) return preflight;

    // 2. Request span
    const reqSpan = startSpan("worker.request");
    setAttr(reqSpan, "method", req.method);
    setAttr(reqSpan, "path", new URL(req.url).pathname);

    // 3. Health check (optional, not all workers)
    if (req.method === "GET" && path === "/health") {
      setAttr(reqSpan, "status", 200);
      endSpan(reqSpan);
      return json({ status: "ok", worker: "worker-name" }, 200);
    }

    // 4. Method check
    if (req.method !== "POST") {
      setAttr(reqSpan, "status", 405);
      endSpan(reqSpan);
      return json({ error: "Method not allowed" }, 405);
    }

    // 5. Parse body
    let body: any;
    try { body = await req.json(); } catch {
      setAttr(reqSpan, "status", 400);
      endSpan(reqSpan);
      return json({ error: "Invalid JSON" }, 400);
    }

    // 6. Route
    const path = new URL(req.url).pathname;
    if (path === "/worker/ask") {
      return handleAsk(body, env, reqSpan, req);
    }
    if (path === "/worker/clear") {
      return handleClear(body, env, reqSpan, req);
    }

    // 7. 404
    setAttr(reqSpan, "status", 404);
    endSpan(reqSpan);
    return json({ error: "Not found" }, 404);
  }
};
```

## Input Guardrails (ai-tutor & ai-assistant)

Both workers have identical input validation:

```typescript
// Length check
if (body.question.length > 2000) {
  return json({ error: "Question too long (max 2000 chars)" }, 400);
}

// Empty check
if (!body.question.trim()) {
  return json({ error: "Question cannot be empty" }, 400);
}

// Prompt injection detection (5 patterns)
const injectionPatterns: RegExp[] = [
  /ignore (all |previous |above )?(instructions|rules|prompt)/i,  // -> "ignore_instructions"
  /system:?\s*(prompt|message|instruction)/i,                     // -> "system_injection"
  /you are now|act as|pretend to be|roleplay as/i,               // -> "roleplay"
  /DAN\b|jailbreak|developer mode/i,                              // -> "jailbreak"
  /\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>/i,                  // -> "special_tokens"
];

for (let i = 0; i < injectionPatterns.length; i++) {
  if (injectionPatterns[i].test(body.question)) {
    // Emit injection_blocked span with named pattern + question_length
    // Return 200 with polite deflection (not 400 — don't reveal detection)
    return json({
      answer: "I'm here to help with [course material / platform content].",
      citations: [],
    }, 200);
  }
}
```

**Why return 200 not 400?** Returning 400 tells the attacker their injection was detected. Returning 200 with a polite deflection looks like the AI just didn't find content.

## ai-assistant Fetch Handler (Complete)

```
GET  /health              → { status: "ok", worker: "ai-assistant" }
POST /assistant/ask       → DO.ask(body)
POST /assistant/clear     → DO.clearHistory(origin)
(other)                   → 404
```

The DO routing:
```typescript
const session = env.ASSISTANT_SESSION.get(
  env.ASSISTANT_SESSION.idFromName(`assistant-${body.learner_id}`)
);
// DO methods return Response directly (they add CORS via shared json())
return session.ask(body);
```

## ai-tutor Fetch Handler (Complete)

```
GET  /health              → { status: "ok", worker: "ai-tutor" }
GET  /diag-search?q=...   → Raw Vectorize query (dev diagnostic)
GET  /tutor/ws?learner_id=...&course_id=...  → WebSocket upgrade
POST /tutor/ask           → DO.ask(body)
POST /tutor/clear         → DO.clearHistory(origin)
(other)                   → 404
```

The WebSocket upgrade path:
```typescript
const session = env.TUTOR_SESSION.get(
  env.TUTOR_SESSION.idFromName(`session-${learnerId}-${courseId}`)
);
// Forward to DO's fetch() which handles WebSocket upgrade
return session.fetch(new Request("https://dummy/ws", { headers: req.headers }));
```

## Simpler Workers (No DO)

Workers without DOs (ai-paths, ai-insights, ai-mentor, ai-bottlenecks, ai-engagement, ai-analytics, ai-question-gen, ai-quality) follow the same pattern but do all work in the fetch handler:

```
1. handleCors()
2. startSpan("worker.request")
3. Validate method = POST
4. Parse body
5. Validate required fields
6. Fetch LMS data (profile, catalog, progress — varies by worker)
7. Build prompt
8. Call gateway
9. Parse response (parseLlmJson)
10. Return answer
```

No DO, no history — each request is independent.
