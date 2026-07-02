// ============================================================
// AI04: Grounded Q&A Tutor
// ============================================================
// Learner asks a question about video lesson content →
// AI answers with citations grounded in real transcripts.
// ============================================================

export interface Env {
  AI: any;
  VECTORIZE_INDEX: VectorizeIndex;
  AI_GATEWAY: Fetcher;
}

// ──── Constants ────

const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const SCORE_THRESHOLD = 0.1;
const TOP_K = 5;
const EXCERPT_MAX_LEN = 300;

// ──── Types ────

interface AskRequest {
  question: string;
  lesson_id: string;
  course_id: string;
  org_id: string;
  expand_scope?: "lesson" | "module" | "course";
  module_id?: string;
}

interface Citation {
  lesson_title: string;
  excerpt: string;
  score: number;
}

interface AskResponse {
  answer: string;
  citations: Citation[];
  scope_expansion_suggested: boolean;
}

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const url = new URL(req.url);
    if (url.pathname !== "/tutor/ask") {
      return json({ error: "Not found" }, 404);
    }

    let body: AskRequest;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    return handleAsk(body, env);
  },
};

// ════════════════════════════════════════════════════════
//  POST /tutor/ask
// ════════════════════════════════════════════════════════

async function handleAsk(body: AskRequest, env: Env): Promise<Response> {
  // ── Validation ──
  if (!body.question || typeof body.question !== "string") {
    return json({ error: "missing_field: question" }, 400);
  }
  if (!body.lesson_id) {
    return json({ error: "missing_field: lesson_id" }, 400);
  }
  if (!body.org_id) {
    return json({ error: "missing_field: org_id" }, 400);
  }

  // ── LMS_INTEGRATION: Fetch lesson metadata ──
  // TODO: When the LMS API is live, fetch lesson metadata here
  // to enrich citations with full title, description, etc.
  //
  //   const resp = await fetch(
  //     `${env.LMS_GATEWAY_URL}/api/v1/lessons/${body.lesson_id}`,
  //     { headers: { "X-API-Key": env.LMS_INTERNAL_KEY } }
  //   );
  //   const lessonMeta = await resp.json();
  //
  // Currently: metadata comes from Vectorize results (stored at index time).
  // Secrets to create: LMS_GATEWAY_URL, LMS_INTERNAL_KEY (via wrangler secret put)

  try {
    // 1. Embed the question
    const embedding = await env.AI.run(EMBEDDING_MODEL, { text: body.question });
    const vector: number[] = embedding.data?.[0] ?? embedding;

    // 2. Build Vectorize filter based on scope (used for post-filter fallback)
    const filter = buildFilter(body);

    // 3. Query Vectorize (without metadata filter until indexes propagate)
    const results = await env.VECTORIZE_INDEX.query(vector, {
      topK: TOP_K,
      returnMetadata: true,
      // filter,  // Uncomment when metadata indexes are fully propagated
    });

    // 4. Post-filter by scope + score threshold
    // TODO: Remove post-filter when Vectorize metadata filter is reliable
    const matches = (results.matches || [])
      .filter((m: any) => {
        if (m.score < SCORE_THRESHOLD) return false;
        // Metadata filter fallback
        for (const [key, val] of Object.entries(filter)) {
          if (m.metadata?.[key] !== val) return false;
        }
        return true;
      });

    if (matches.length === 0) {
      return json({
        answer: "I couldn't find that in this lesson.",
        citations: [],
        scope_expansion_suggested: true,
      });
    }

    // 5. Build grounded prompt
    const citations: Citation[] = matches.map((m: any) => ({
      lesson_title: m.metadata?.title || "Untitled",
      excerpt: (m.metadata?.content || "").substring(0, EXCERPT_MAX_LEN),
      score: m.score,
    }));

    const prompt = buildPrompt(citations, body.question);

    // 6. Call AI03 Gateway
    const gatewayResp = await env.AI_GATEWAY.fetch(
      new Request("https://ai-gateway/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          tier: "standard",
          org_id: body.org_id,
        }),
      })
    );

    if (!gatewayResp.ok) {
      const err = await gatewayResp.text();
      return json({ error: `AI Gateway error: ${err}` }, 502);
    }

    const llm = await gatewayResp.json() as any;

    return json({
      answer: llm.response,
      citations,
      scope_expansion_suggested: false,
    });
  } catch (err: any) {
    return json({ error: `Tutor error: ${err.message}` }, 500);
  }
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

/** Build Vectorize metadata filter based on scope. */
function buildFilter(body: AskRequest): Record<string, string> {
  const scope = body.expand_scope || "lesson";
  const filter: Record<string, string> = { org_id: body.org_id };

  switch (scope) {
    case "lesson":
      filter["lesson_id"] = body.lesson_id;
      break;
    case "module":
      if (body.module_id) filter["module_id"] = body.module_id;
      filter["course_id"] = body.course_id;
      break;
    case "course":
      filter["course_id"] = body.course_id;
      break;
  }

  return filter;
}

/** Build the grounded prompt that forces the LLM to use only provided content. */
function buildPrompt(citations: Citation[], question: string): string {
  const contentBlocks = citations
    .map((c) => `[Lesson: ${c.lesson_title}]
${c.excerpt}`)
    .join("\n\n");

  return [
    "Answer the question based on the provided content below.",
    "If the content is irrelevant to the question, say \"I couldn't find that in this lesson.\"",
    "Cite the lesson title for each fact. Be concise.",
    "",
    "CONTENT:",
    contentBlocks,
    "",
    `QUESTION: ${question}`,
  ].join("\n");
}

/** Tiny JSON helper. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
