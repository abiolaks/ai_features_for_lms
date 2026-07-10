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
      return handleDiagSearch(url, env);
    }

    // GET /tutor/ws?learner_id=... — WebSocket upgrade (streaming tutor)
    if (req.method === "GET" && path === "/tutor/ws") {
      const learnerId = url.searchParams.get("learner_id");
      if (!learnerId) {
        return json({ error: "missing_param: learner_id" }, 400);
      }
      const session = env.TUTOR_SESSION.get(
        env.TUTOR_SESSION.idFromName(`session-${learnerId}`)
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
      let body: { learner_id: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.learner_id) {
        return json({ error: "missing_field: learner_id" }, 400);
      }
      const session = env.TUTOR_SESSION.get(
        env.TUTOR_SESSION.idFromName(`session-${body.learner_id}`)
      );
      return session.clearHistory();
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

      // Deterministic routing: same learner → same DO instance
      const session = env.TUTOR_SESSION.get(
        env.TUTOR_SESSION.idFromName(`session-${body.learner_id}`)
      );
      return session.ask(body);
    }

    return json({ error: "Not found" }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  GET /diag-search?q=... — Raw Vectorize diagnostic
// ════════════════════════════════════════════════════════

async function handleDiagSearch(url: URL, env: Env): Promise<Response> {
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
    return json({ query: q, total: matches.length, vector_dim: vector.length, matches });
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
}


