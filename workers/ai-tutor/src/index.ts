// ============================================================
// AI04: Grounded Q&A Tutor
// ============================================================
// Learner asks a question about lesson content →
// AI answers with citations grounded in real transcripts.
// Conversation history persisted per-session via Durable Objects.
// ============================================================

import { TutorSession } from "./TutorSession";
import { json, handleCors } from "../../shared/cors";

export { TutorSession };

export interface Env {
  AI: any;
  VECTORIZE_INDEX: VectorizeIndex;
  AI_GATEWAY: Fetcher;
  TUTOR_SESSION: DurableObjectNamespace<TutorSession>;
}

// ──── Constants ────

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

// ──── Types ────

interface AskRequest {
  question: string;
  learner_id: string;        // NEW — routes to the right DO
  lesson_id: string;
  course_id: string;
  org_id: string;
  expand_scope?: "lesson" | "module" | "course";
  module_id?: string;
  origin?: string | null;    // set by fetch handler for CORS
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

    // GET /diag-search?q=... — raw Vectorize query (dev diagnostic)
    if (req.method === "GET" && path === "/diag-search") {
      return handleDiagSearch(url, env, req.headers.get("Origin"));
    }

    // GET /tutor/ws?learner_id=...&course_id=... — WebSocket upgrade (streaming tutor)
    if (req.method === "GET" && path === "/tutor/ws") {
      const learnerId = url.searchParams.get("learner_id");
      const courseId = url.searchParams.get("course_id") || "default";
      if (!learnerId) {
        return json({ error: "missing_param: learner_id" }, 400);
      }
      const session = env.TUTOR_SESSION.get(
        env.TUTOR_SESSION.idFromName(`session-${learnerId}-${courseId}`)
      );
      // Forward to DO's fetch() which handles the WebSocket upgrade
      return session.fetch(
        new Request(`https://dummy/ws`, {
          headers: req.headers,
        })
      );
    }

    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    // POST /tutor/clear — clear a session's history
    if (path === "/tutor/clear") {
      let body: { learner_id: string; course_id?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.learner_id) {
        return json({ error: "missing_field: learner_id" }, 400);
      }
      const courseId = body.course_id || "default";
      const session = env.TUTOR_SESSION.get(
        env.TUTOR_SESSION.idFromName(`session-${body.learner_id}-${courseId}`)
      );
      return session.clearHistory(req.headers.get("Origin"));
    }

    // POST /tutor/ask — route to the learner's DO
    if (path === "/tutor/ask") {
      let body: AskRequest;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      if (!body.question) return json({ error: "missing_field: question" }, 400);
      if (!body.learner_id) return json({ error: "missing_field: learner_id" }, 400);
      if (!body.lesson_id) return json({ error: "missing_field: lesson_id" }, 400);
      if (!body.org_id) return json({ error: "missing_field: org_id" }, 400);

      // ── Input guardrails ──
      // Reject overly long questions (potential abuse/DoS)
      if (body.question.length > 2000) {
        return json({ error: "Question too long (max 2000 chars)" }, 400);
      }
      // Reject empty/whitespace-only questions
      if (!body.question.trim()) {
        return json({ error: "Question cannot be empty" }, 400);
      }
      // Basic prompt injection pattern detection
      const injectionPatterns = [
        /ignore (all |previous |above )?(instructions|rules|prompt)/i,
        /system:?\s*(prompt|message|instruction)/i,
        /you are now|act as|pretend to be|roleplay as/i,
        /DAN\b|jailbreak|developer mode/i,
        /\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>/i,
      ];
      for (const pattern of injectionPatterns) {
        if (pattern.test(body.question)) {
          return json({
            answer: "I'm here to help with course material. Let me know if you have questions about the lessons.",
            citations: [],
            scope_expansion_suggested: false,
          }, 200);
        }
      }

      // Attach origin for CORS headers in DO response
      body.origin = req.headers.get("Origin");

      // Deterministic routing: same learner + same course → same DO instance
      // Each course gets its own conversation history
      const courseId = body.course_id || "default";
      const session = env.TUTOR_SESSION.get(
        env.TUTOR_SESSION.idFromName(`session-${body.learner_id}-${courseId}`)
      );
      return session.ask(body);
    }

    return json({ error: "Not found" }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  GET /diag-search?q=... — Raw Vectorize diagnostic
// ════════════════════════════════════════════════════════

async function handleDiagSearch(url: URL, env: Env, origin?: string | null): Promise<Response> {
  const q = url.searchParams.get("q") || "test";
  try {
    const embedding = await env.AI.run(EMBEDDING_MODEL, { text: q });
    const vector: number[] = embedding.data?.[0] ?? embedding;
    const results = await env.VECTORIZE_INDEX.query(vector, {
      topK: 10,
      returnMetadata: true,
    });
    const matches = (results.matches || []).map((m: any) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata,
    }));
    return json({ query: q, total: matches.length, vector_dim: vector.length, matches }, 200, origin);
  } catch (err: any) {
    return json({ error: err.message }, 500, origin);
  }
}


