// ============================================================
// AI09: Platform Assistant
// ============================================================
// Chat-based assistant that answers platform-wide questions
// across all courses. Scoped at the course level (unlike the
// Tutor which is lesson-scoped). Returns course recommendations
// inline with answers. Multi-turn conversation via DO per learner.
// ============================================================

import { AssistantSession } from "./AssistantSession";
import { json, handleCors } from "../../shared/cors";
import { startSpan, setAttr, endSpan } from "../../shared/observability";

export { AssistantSession };

export interface Env {
  AI: any;
  VECTORIZE_INDEX: VectorizeIndex;
  AI_GATEWAY: Fetcher;
  ASSISTANT_SESSION: DurableObjectNamespace<AssistantSession>;
  LMS_GATEWAY_URL: string;
  LMS_INTERNAL_KEY: string;
}

// ──── Types ────

interface AskRequest {
  question: string;
  learner_id: string;
  org_id: string;
  origin?: string | null;
}

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // ── CORS preflight ──
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);
    const path = url.pathname;

    // ── Request span — captures every code path ──
    const reqSpan = startSpan("assistant.request");
    setAttr(reqSpan, "method", req.method);
    setAttr(reqSpan, "path", path);

    // GET /health — uptime check (no DO wake, no auth required)
    if (req.method === "GET" && path === "/health") {
      setAttr(reqSpan, "status", 200);
      endSpan(reqSpan);
      return json({ status: "ok", worker: "ai-assistant" }, 200);
    }

    if (req.method !== "POST") {
      setAttr(reqSpan, "status", 405);
      endSpan(reqSpan);
      return json({ error: "Method not allowed" }, 405);
    }

    // POST /assistant/clear — clear a session's history
    if (path === "/assistant/clear") {
      let body: { learner_id: string };
      try {
        body = await req.json();
      } catch {
        setAttr(reqSpan, "status", 400);
        endSpan(reqSpan);
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.learner_id) {
        setAttr(reqSpan, "status", 400);
        endSpan(reqSpan);
        return json({ error: "missing_field: learner_id" }, 400);
      }
      const session = env.ASSISTANT_SESSION.get(
        env.ASSISTANT_SESSION.idFromName(`assistant-${body.learner_id}`)
      );
      const clearResp = await session.clearHistory(req.headers.get("Origin"));
      setAttr(reqSpan, "status", clearResp.status);
      endSpan(reqSpan);
      return clearResp;
    }

    // POST /assistant/ask — route to the learner's DO
    if (path === "/assistant/ask") {
      let body: AskRequest;
      try {
        body = await req.json();
      } catch {
        setAttr(reqSpan, "status", 400);
        endSpan(reqSpan);
        return json({ error: "Invalid JSON" }, 400);
      }

      if (!body.question) { setAttr(reqSpan, "status", 400); endSpan(reqSpan); return json({ error: "missing_field: question" }, 400); }
      if (!body.learner_id) { setAttr(reqSpan, "status", 400); endSpan(reqSpan); return json({ error: "missing_field: learner_id" }, 400); }
      if (!body.org_id) { setAttr(reqSpan, "status", 400); endSpan(reqSpan); return json({ error: "missing_field: org_id" }, 400); }

      // ── Input guardrails ──
      if (body.question.length > 2000) {
        setAttr(reqSpan, "status", 400);
        endSpan(reqSpan);
        return json({ error: "Question too long (max 2000 chars)" }, 400);
      }
      if (!body.question.trim()) {
        setAttr(reqSpan, "status", 400);
        endSpan(reqSpan);
        return json({ error: "Question cannot be empty" }, 400);
      }
      const INJECTION_PATTERN_NAMES = [
        "ignore_instructions",
        "system_injection",
        "roleplay",
        "jailbreak",
        "special_tokens",
      ] as const;
      const injectionPatterns: RegExp[] = [
        /ignore (all |previous |above )?(instructions|rules|prompt)/i,
        /system:?\s*(prompt|message|instruction)/i,
        /you are now|act as|pretend to be|roleplay as/i,
        /DAN\b|jailbreak|developer mode/i,
        /\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>/i,
      ];
      for (let i = 0; i < injectionPatterns.length; i++) {
        if (injectionPatterns[i].test(body.question)) {
          const blockSpan = startSpan("assistant.injection_blocked");
          setAttr(blockSpan, "pattern", INJECTION_PATTERN_NAMES[i]);
          setAttr(blockSpan, "question_length", body.question.length);
          endSpan(blockSpan);
          setAttr(reqSpan, "status", 200);
          endSpan(reqSpan);
          return json({
            answer: "I'm here to help with platform content and courses. Let me know if you have questions about what to learn!",
            citations: [],
            suggested_courses: [],
          }, 200);
        }
      }

      // Attach origin for CORS headers in DO response
      body.origin = req.headers.get("Origin");

      // Deterministic routing: same learner → same DO instance
      // Platform assistant is global — one DO per learner across all courses
      const session = env.ASSISTANT_SESSION.get(
        env.ASSISTANT_SESSION.idFromName(`assistant-${body.learner_id}`)
      );
      const askResp = await session.ask(body);
      setAttr(reqSpan, "status", askResp.status);
      endSpan(reqSpan);
      return askResp;
    }

    setAttr(reqSpan, "status", 404);
    endSpan(reqSpan);
    return json({ error: "Not found" }, 404);
  },
};
