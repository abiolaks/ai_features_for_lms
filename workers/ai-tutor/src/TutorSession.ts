// ============================================================
// AI04: TutorSession Durable Object
// ============================================================
// One DO per learner session. Stores conversation history in
// SQLite, supports both HTTP RPC (backward compat) and
// WebSocket streaming for real-time token delivery.
// ============================================================

import { DurableObject } from "cloudflare:workers";

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";
const SCORE_THRESHOLD = 0.1;
const TOP_K = 15;
const EXCERPT_MAX_LEN = 2000;
const MAX_HISTORY_MESSAGES = 20;

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

interface MessageRow {
  role: string;
  content: string;
}

interface Env {
  AI: any;
  VECTORIZE_INDEX: VectorizeIndex;
  AI_GATEWAY: Fetcher;
}

// ════════════════════════════════════════════════════════
//  TutorSession Durable Object
// ════════════════════════════════════════════════════════

export class TutorSession extends DurableObject<Env> {
  private currentAnswer = ""; // accumulated during streaming

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    });
  }

  // ── WebSocket upgrade handler ──

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // GET /ws — WebSocket upgrade
    if (url.pathname === "/ws" && req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── WebSocket message handler ──

  async webSocketMessage(ws: WebSocket, message: string) {
    let msg: { type: string; [key: string]: any };
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "ask":
        await this.handleStreamAsk(ws, msg as AskRequest & { type: string });
        break;
      case "cancel":
        // TODO: implement stream cancellation
        ws.send(JSON.stringify({ type: "cancelled" }));
        break;
      default:
        ws.send(JSON.stringify({ type: "error", error: `Unknown type: ${msg.type}` }));
    }
  }

  async webSocketClose(_ws: WebSocket) {
    // DO stays alive — history persists in SQLite
  }

  async webSocketError(_ws: WebSocket, _err: Error) {
    // Connection dropped — state is safe in SQLite
  }

  // ── HTTP RPC: ask a question (backward compat, no streaming) ──

  async ask(body: AskRequest): Promise<Response> {
    try {
      const history = this.loadHistory();
      const { prompt, citations } = await this.buildGroundedPrompt(body, history);

      if (!prompt) {
        return json({
          answer: "I couldn't find that in this lesson.",
          citations: [],
          scope_expansion_suggested: true,
        });
      }

      // Non-streaming call to gateway
      const gatewayResp = await this.env.AI_GATEWAY.fetch(
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
        return json({ error: `AI Gateway error: ${await gatewayResp.text()}` }, 502);
      }

      const llm = await gatewayResp.json() as any;
      this.saveExchange(body.question, llm.response);

      return json({
        answer: llm.response,
        citations,
        scope_expansion_suggested: false,
        history_length: history.length + 2,
      });
    } catch (err: any) {
      return json({ error: `Tutor error: ${err.message}` }, 500);
    }
  }

  // ── RPC: clear conversation history ──

  async clearHistory(): Promise<Response> {
    this.ctx.storage.sql.exec("DELETE FROM messages");
    return json({ status: "cleared" });
  }

  // ═══════════════════════════════════════════════════════
  //  Streaming ask (WebSocket)
  // ═══════════════════════════════════════════════════════

  private async handleStreamAsk(ws: WebSocket, body: AskRequest & { type: string }) {
    const { question, org_id } = body;

    try {
      const history = this.loadHistory();
      const { prompt, citations } = await this.buildGroundedPrompt(body, history);

      if (!prompt) {
        ws.send(JSON.stringify({
          type: "done",
          answer: "I couldn't find that in this lesson.",
          citations: [],
          scope_expansion_suggested: true,
        }));
        return;
      }

      // Send citations first so the UI can show sources
      ws.send(JSON.stringify({
        type: "citations",
        citations: citations.map((c: Citation) => ({
          lesson_title: c.lesson_title,
          excerpt: c.excerpt.substring(0, 200), // keep ws msg small
          score: c.score,
        })),
      }));

      // Call gateway streaming endpoint
      const gatewayResp = await this.env.AI_GATEWAY.fetch(
        new Request("https://ai-gateway/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            tier: "standard",
            org_id,
          }),
        })
      );

      if (!gatewayResp.ok || !gatewayResp.body) {
        ws.send(JSON.stringify({ type: "error", error: "Stream failed" }));
        return;
      }

      // Read SSE stream from gateway, forward tokens to client
      const reader = gatewayResp.body.getReader();
      const decoder = new TextDecoder();
      this.currentAnswer = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "token") {
              this.currentAnswer += data.text;
              ws.send(JSON.stringify({ type: "token", text: data.text }));
            } else if (data.type === "done") {
              this.currentAnswer = data.response || this.currentAnswer;
            }
          } catch {
            // skip unparseable
          }
        }
      }

      // Flush remaining buffer
      if (buffer.startsWith("data: ")) {
        try {
          const data = JSON.parse(buffer.slice(6));
          if (data.type === "done") {
            this.currentAnswer = data.response || this.currentAnswer;
          }
        } catch { /* ignore */ }
      }

      // Save to history
      this.saveExchange(question, this.currentAnswer);

      // Signal completion
      ws.send(JSON.stringify({
        type: "done",
        answer: this.currentAnswer,
        history_length: history.length + 2,
      }));
    } catch (err: any) {
      ws.send(JSON.stringify({ type: "error", error: err.message }));
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Shared prompt builder
  // ═══════════════════════════════════════════════════════

  private async buildGroundedPrompt(
    body: AskRequest,
    history: MessageRow[]
  ): Promise<{ prompt: string | null; citations: Citation[] }> {
    // Embed question
    const embedding = await this.env.AI.run(EMBEDDING_MODEL, { text: body.question });
    const vector: number[] = embedding.data?.[0] ?? embedding;

    // Query Vectorize
    const filter = buildFilter(body);
    const results = await this.env.VECTORIZE_INDEX.query(vector, {
      topK: TOP_K,
      returnMetadata: true,
    });

    const matches = (results.matches || [])
      .filter((m: any) => {
        if (m.score < SCORE_THRESHOLD) return false;
        for (const [key, val] of Object.entries(filter)) {
          if (!val) continue;  // skip empty filter values
          const metaVal = m.metadata?.[key];
          // org_id must always match exactly
          if (key === "org_id") {
            if (metaVal !== val) return false;
          } else {
            // course_id, module_id, lesson_id: skip if metadata is empty (unset)
            if (metaVal && metaVal !== "" && metaVal !== val) return false;
          }
        }
        return true;
      });

    if (matches.length === 0) {
      return { prompt: null, citations: [] };
    }

    const citations: Citation[] = matches.map((m: any) => ({
      lesson_title: m.metadata?.title || "Untitled",
      excerpt: (m.metadata?.content || "").substring(0, EXCERPT_MAX_LEN),
      score: m.score,
    }));

    const prompt = buildPrompt(history, citations, body.question);
    return { prompt, citations };
  }

  // ═══════════════════════════════════════════════════════
  //  History management
  // ═══════════════════════════════════════════════════════

  private loadHistory(): MessageRow[] {
    const rows = this.ctx.storage.sql.exec<MessageRow>(
      "SELECT role, content FROM messages ORDER BY id DESC LIMIT ?",
      MAX_HISTORY_MESSAGES
    );
    return rows.toArray().reverse();
  }

  private saveExchange(question: string, answer: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, content) VALUES (?, ?), (?, ?)",
      "user", question,
      "assistant", answer
    );
    this.ctx.storage.sql.exec(`
      DELETE FROM messages WHERE id NOT IN (
        SELECT id FROM messages ORDER BY id DESC LIMIT ?
      )
    `, MAX_HISTORY_MESSAGES);
  }
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function buildFilter(body: AskRequest): Record<string, string> {
  const scope = body.expand_scope || "lesson";
  const filter: Record<string, string> = { org_id: body.org_id };
  switch (scope) {
    case "lesson": filter["lesson_id"] = body.lesson_id; break;
    case "module":
      if (body.module_id) filter["module_id"] = body.module_id;
      filter["course_id"] = body.course_id;
      break;
    case "course": filter["course_id"] = body.course_id; break;
  }
  return filter;
}

function buildPrompt(history: MessageRow[], citations: Citation[], question: string): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push("PREVIOUS CONVERSATION:");
    for (const msg of history) {
      parts.push(`${msg.role === "user" ? "Learner" : "Tutor"}: ${msg.content}`);
    }
    parts.push("");
  }
  const contentBlocks = citations
    .map((c) => `[Lesson: ${c.lesson_title}]\n${c.excerpt}`)
    .join("\n\n");
  parts.push(
    "Answer the question based on the provided content below.",
    "If the content is irrelevant, say \"I couldn't find that in this lesson.\"",
    "Cite the lesson title for each fact. Be concise.",
    "If there is previous conversation, use that context.",
    "",
    "CONTENT:",
    contentBlocks,
    "",
    `QUESTION: ${question}`
  );
  return parts.join("\n");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
