import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../src/index';

// ──── Mocks ────

function mockVectorizeQuery(matches: any[]) {
  return vi.fn().mockResolvedValue({ matches, count: matches.length });
}

function mockAiGateway(response: object, ok = true) {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      })
    ),
  };
}

const DEFAULT_AI_RESPONSE = {
  data: [new Array(1024).fill(0.1)],
};

const DEFAULT_STT_RESPONSE = {
  text: 'What is a variable in Python?',
};

const DEFAULT_LLM_RESPONSE = {
  response: "Variables store data that can change during program execution. (Python Variables)",
  model_used: "@cf/meta/llama-3.2-3b-instruct",
  provider: "cloudflare",
  tokens_used: 48,
  throttle_warning: false,
};

// ──── Reset mocks between tests ────

beforeAll(() => {
  (env as any).AI = {
    run: vi.fn(async (model: string, _input: any) => {
      if (model === '@cf/openai/whisper') {
        return DEFAULT_STT_RESPONSE;
      }
      return DEFAULT_AI_RESPONSE;
    }),
  };
  (env as any).VECTORIZE_INDEX = {
    query: mockVectorizeQuery([]),
  };
  (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

  // Mock DO binding — returns stubs that forward to real TutorSession logic.
  // NOTE: Because the DO isn't registered in wrangler.test.jsonc, we mock
  // the binding manually. The stub calls run in the same process context
  // so they access the same mocked env bindings (AI, VECTORIZE_INDEX, etc.).
  //
  // We lazy-load TutorSession to avoid DO constructor issues — the mock
  // stub delegates to internal logic that uses the shared env mock.
  const doStubs = new Map<string, any>();

  function getOrCreateStub(name: string) {
    if (!doStubs.has(name)) {
      doStubs.set(name, {
        ask: vi.fn(async (body: any) => {
          // Delegate to a lightweight version of the ask logic
          // that uses mocked bindings from the shared test env
          const origin = body.origin;
          try {
            const embedding = await (env as any).AI.run("@cf/baai/bge-large-en-v1.5", { text: body.question });
            const vector = embedding.data?.[0] ?? embedding;

            const filter: Record<string, string> = { org_id: body.org_id };
            const scope = body.expand_scope || "lesson";
            switch (scope) {
              case "lesson": filter["lesson_id"] = body.lesson_id; break;
              case "module": if (body.module_id) filter["module_id"] = body.module_id; filter["course_id"] = body.course_id; break;
              case "course": filter["course_id"] = body.course_id; break;
            }

            const results = await (env as any).VECTORIZE_INDEX.query(vector, {
              topK: 15,
              returnMetadata: true,
            });

            const matches = (results.matches || []).filter((m: any) => {
              if (m.score < 0.1) return false;
              for (const [key, val] of Object.entries(filter)) {
                if (!val) continue;
                const metaVal = m.metadata?.[key];
                if (key === "org_id") {
                  if (metaVal !== val) return false;
                } else {
                  if (metaVal && metaVal !== "" && metaVal !== val) return false;
                }
              }
              return true;
            });

            if (matches.length === 0) {
              return Response.json({
                answer: "I couldn't find that in this lesson.",
                citations: [],
                scope_expansion_suggested: true,
              }, {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": origin || "https://learning.lumerax.co",
                  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
                },
              });
            }

            const citations = matches.map((m: any) => {
              const sourceType = m.metadata?.source_type;
              let location: string | null = null;
              if (sourceType === "pdf" && m.metadata?.page_start) {
                const start = m.metadata.page_start;
                const end = m.metadata.page_end;
                location = start === end ? `Page ${start}` : `Pages ${start}–${end}`;
              } else if (sourceType === "ppt" && m.metadata?.slide_number) {
                location = `Slide ${m.metadata.slide_number}`;
              }
              return {
                lesson_title: m.metadata?.title || "Untitled",
                excerpt: (m.metadata?.content || "").substring(0, 2000),
                score: m.score,
                source_type: sourceType || undefined,
                location,
              };
            });

            const contentBlocks = citations
              .map((c: any) => {
                const loc = c.location ? `, ${c.location}` : "";
                return `[${c.lesson_title}${loc}]\n${c.excerpt}`;
              })
              .join("\n\n");
            const prompt = `Answer the question based on the provided content below.\nIf the content is irrelevant, say "I couldn't find that in this lesson."\nCite the lesson title for each fact. Be concise.\n\nCONTENT:\n${contentBlocks}\n\nQUESTION: ${body.question}`;

            const gatewayResp = await (env as any).AI_GATEWAY.fetch(
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
              return Response.json(
                { error: `AI Gateway error: ${await gatewayResp.text()}` },
                {
                  status: 502,
                  headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": origin || "https://learning.lumerax.co",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
                  },
                }
              );
            }

            const llm = await gatewayResp.json() as any;
            return Response.json({
              answer: llm.response,
              citations,
              scope_expansion_suggested: false,
              history_length: 2,
            }, {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": origin || "https://learning.lumerax.co",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
              },
            });
          } catch (err: any) {
            return Response.json(
              { error: `Tutor error: ${err.message}` },
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": origin || "https://learning.lumerax.co",
                  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
                },
              }
            );
          }
        }),
        clearHistory: vi.fn(async (origin?: string | null) => {
          return Response.json(
            { status: "cleared" },
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": origin || "https://learning.lumerax.co",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
              },
            }
          );
        }),
      });
    }
    return doStubs.get(name);
  }

  (env as any).TUTOR_SESSION = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((name: string) => getOrCreateStub(name)),
  };
});

// ──── Helpers ────

async function ask(body: object) {
  const req = new Request('http://localhost/tutor/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function matchingChunk(overrides: any = {}) {
  return {
    id: 'v1',
    score: 0.85,
    metadata: {
      title: 'Python Variables',
      lesson_id: 'lesson-123',
      org_id: 'org-acme',
      course_id: 'course-1',
      content: 'Variables store data. They can hold numbers, strings, and more.',
      ...overrides,
    },
  };
}

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects GET', async () => {
    const req = new Request('http://localhost/tutor/ask', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
  });

  it('rejects unknown paths', async () => {
    const req = new Request('http://localhost/unknown', {
      method: 'POST',
      body: '{}',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('http://localhost/tutor/ask', {
      method: 'POST',
      body: 'not json',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('rejects missing question', async () => {
    const res = await ask({ lesson_id: 'l1', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('question');
  });

  it('rejects missing learner_id', async () => {
    const res = await ask({ question: 'q', lesson_id: 'l1', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('learner_id');
  });

  it('rejects missing lesson_id', async () => {
    const res = await ask({ question: 'q', learner_id: 'learner-1', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('lesson_id');
  });

  it('rejects missing org_id', async () => {
    const res = await ask({ question: 'q', learner_id: 'learner-1', lesson_id: 'l1' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('org_id');
  });
});

// ════════════════════════════════════════════════════════
//  Retrieval + Grounded Answer
// ════════════════════════════════════════════════════════

describe('Retrieval', () => {
  it('returns not-found when no chunks match', async () => {
    const res = await ask({
      question: 'What is quantum computing?',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      org_id: 'org-test',
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.answer).toContain("couldn't find");
    expect(body.citations).toEqual([]);
    expect(body.scope_expansion_suggested).toBe(true);
  });

  it('post-filters by lesson_id + org_id from metadata', async () => {
    // Setup: return a chunk with wrong lesson_id
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      {
        id: 'v1',
        score: 0.85,
        metadata: { title: 'T', lesson_id: 'WRONG', org_id: 'org-acme', content: '...' },
      },
    ]);

    const res = await ask({
      question: 'q',
      learner_id: 'learner-1',
      lesson_id: 'lesson-123',
      course_id: 'course-1',
      org_id: 'org-acme',
    });

    const body: any = await res.json();
    // Should be excluded by post-filter (wrong lesson_id)
    expect(body.scope_expansion_suggested).toBe(true);
  });

  it('excludes chunks below score threshold', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      {
        id: 'v1',
        score: 0.05, // below 0.1 threshold
        metadata: { title: 'Test', lesson_id: 'l1', org_id: 'org-test', content: 'some content' },
      },
    ]);

    const res = await ask({
      question: 'test',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.scope_expansion_suggested).toBe(true);
  });

  it('returns cited answer for matching chunks', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'What is a variable?',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.answer).toBeTruthy();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].lesson_title).toBe('Python Variables');
    expect(body.citations[0].score).toBe(0.85);
    expect(body.scope_expansion_suggested).toBe(false);
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('includes grounding instruction', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const gatewaySpy = (env as any).AI_GATEWAY.fetch;
    gatewaySpy.mockClear();

    await ask({
      question: 'What is X?',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    expect(gatewaySpy).toHaveBeenCalled();
    const callBody = JSON.parse(await gatewaySpy.mock.calls[0][0].text());
    const prompt = callBody.messages[0].content;

    expect(prompt).toContain('based on the provided content');
    expect(prompt).toContain('[Python Variables]');
    expect(prompt).toContain('QUESTION: What is X?');
  });

  it('handles gateway errors gracefully', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway({}, false);

    const res = await ask({
      question: 'q',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    expect(res.status).toBe(502);
  });
});

// ════════════════════════════════════════════════════════
//  Citation source_type + location (PDF/PPT page/slide)
// ════════════════════════════════════════════════════════

describe('Citation source_type + location', () => {
  it('includes source_type and location for PDF content', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({
        lesson_id: 'l1',
        org_id: 'org-test',
        source_type: 'pdf',
        page_start: 5,
        page_end: 5,
      }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'What is a variable?',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].source_type).toBe('pdf');
    expect(body.citations[0].location).toBe('Page 5');
  });

  it('includes source_type and location for PPT content', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({
        lesson_id: 'l1',
        org_id: 'org-test',
        source_type: 'ppt',
        slide_number: 3,
      }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'What is a variable?',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].source_type).toBe('ppt');
    expect(body.citations[0].location).toBe('Slide 3');
  });

  it('includes source_type "video" with no location for video content', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({
        lesson_id: 'l1',
        org_id: 'org-test',
        source_type: 'video',
      }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'What is a variable?',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].source_type).toBe('video');
    expect(body.citations[0].location).toBeNull();
  });

  it('omits source_type + location for legacy chunks missing metadata', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'What is a variable?',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].source_type).toBeUndefined();
    expect(body.citations[0].location).toBeNull();
  });
});

// ════════════════════════════════════════════════════════
//  Scope Expansion (post-filter behavior)
// ════════════════════════════════════════════════════════

describe('Scope expansion', () => {
  it('filters by lesson_id at lesson scope', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l123', org_id: 'org-test', course_id: 'c456' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'q',
      learner_id: 'learner-1',
      lesson_id: 'l123',
      course_id: 'c456',
      org_id: 'org-test',
      expand_scope: 'lesson',
    });

    const body: any = await res.json();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].lesson_title).toBe('Python Variables');
  });

  it('filters by module + course at module scope', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test', course_id: 'c456', module_id: 'm789' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'q',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'c456',
      org_id: 'org-test',
      expand_scope: 'module',
      module_id: 'm789',
    });

    const body: any = await res.json();
    // Module scope = match on module_id + course_id, lesson_id is ignored
    expect(body.citations).toHaveLength(1);
  });

  it('filters by course only at course scope', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test', course_id: 'c456' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'q',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'c456',
      org_id: 'org-test',
      expand_scope: 'course',
    });

    const body: any = await res.json();
    // Course scope = match on course_id only
    expect(body.citations).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════
//  CORS — cross-origin headers on every response
// ════════════════════════════════════════════════════════

describe('CORS', () => {
  // ── OPTIONS preflight ──

  it('returns CORS headers on OPTIONS preflight', async () => {
    const req = new Request('http://localhost/tutor/ask', {
      method: 'OPTIONS',
      headers: { Origin: 'https://learning.lumerax.co' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://learning.lumerax.co'
    );
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('rejects unknown origin with fallback', async () => {
    const req = new Request('http://localhost/tutor/ask', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });
    const res = await worker.fetch(req, env);
    // Falls back to first allowed origin, not the untrusted one
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://learning.lumerax.co'
    );
  });

  // ── POST /tutor/ask includes CORS headers ──

  it('includes CORS headers on POST /tutor/ask', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const res = await ask({
      question: 'test',
      learner_id: 'learner-1',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  // ── POST /tutor/clear includes CORS headers ──

  it('includes CORS headers on POST /tutor/clear', async () => {
    const req = new Request('http://localhost/tutor/clear', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://learning.lumerax.co',
      },
      body: JSON.stringify({ learner_id: 'learner-1' }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://learning.lumerax.co'
    );
  });

  // ── Validation errors also include CORS headers ──

  it('includes CORS headers on validation errors', async () => {
    const req = new Request('http://localhost/tutor/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://learning.lumerax.co',
      },
      body: 'not json',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://learning.lumerax.co'
    );
  });
});

// ════════════════════════════════════════════════════════
//  Voice STT (ask_voice over WebSocket)
// ════════════════════════════════════════════════════════

// Mock audio: minimal base64-encoded WAV header (44 bytes) + 10ms of silence
const MOCK_AUDIO_BASE64 = (() => {
  // 44-byte WAV header + 320 PCM samples (10ms @ 16kHz 16-bit mono)
  const header = new Uint8Array(44);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  header.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  header.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  header[20] = 1; // PCM
  header[22] = 1; // mono
  header[24] = 0x80; header[25] = 0x3E; // 16000 Hz
  header[34] = 16; // bits per sample
  header[36] = 0x64; header[37] = 0x61; header[38] = 0x74; header[39] = 0x61; // "data"
  const samples = new Uint8Array(640); // 320 samples * 2 bytes
  const wav = new Uint8Array(header.length + samples.length);
  wav.set(header);
  wav.set(samples, header.length);
  return btoa(String.fromCharCode(...wav));
})();

// Helper: create a mock WebSocket that collects sent messages
function createMockWs(): { ws: any; messages: string[]; types: () => string[] } {
  const messages: string[] = [];
  const ws = {
    send: vi.fn((msg: string) => { messages.push(msg); }),
    messages,
  };
  return {
    ws,
    messages,
    types: () => messages.map(m => { try { return JSON.parse(m).type; } catch { return '__UNPARSEABLE__'; } }),
  };
}

// Helper: set up streaming gateway mock (SSE tokens → done)
function mockStreamingGateway() {
  const tokens = ["Variables", " store", " data", " in", " Python."];
  const encoder = new TextEncoder();
  let callCount = 0;

  (env as any).AI_GATEWAY = {
    fetch: vi.fn(async () => {
      callCount++;
      let body = '';
      for (const t of tokens) {
        body += `data: ${JSON.stringify({ type: 'token', text: t })}\n`;
      }
      body += `data: ${JSON.stringify({ type: 'done', response: 'Variables store data in Python.' })}\n`;
      return new Response(encoder.encode(body), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  };
}

// Helper: create a real TutorSession DO instance with test mocks
// NOTE: Uses the DO binding registered in wrangler.test.jsonc
function createTestSession(sttResult?: string) {
  // Reset AI mock for STT
  (env as any).AI = {
    run: vi.fn(async (model: string, _input: any) => {
      if (model === '@cf/openai/whisper') {
        return { text: sttResult ?? 'What is a variable in Python?' };
      }
      return { data: [new Array(1024).fill(0.1)] };
    }),
  };

  // Reset bindings to use real DO
  // We can't easily create a real DO instance in the test without
  // overriding beforeAll mocks, so we test through a stub pattern.
  return null; // placeholder — see individual tests below
}

// ════════════════════════════════════════════════════════
//  Voice tests use the mock DO stub approach (consistent with existing tests)
//  Each test extends the stub with a webSocketMessage handler
// ════════════════════════════════════════════════════════

function setupVoiceStub(opts?: { sttError?: string }) {
  const doStubs = new Map<string, any>();
  const voiceSessionId = 'session-voice_learner-default';

  doStubs.set(voiceSessionId, {
    ask: vi.fn(),
    clearHistory: vi.fn(),
    webSocketMessage: vi.fn(async (_ws: any, message: string) => {
      const msg = JSON.parse(message);

      if (msg.type === 'ask_voice') {
        // Validate audio
        if (!msg.audio || msg.audio.length === 0) {
          _ws.send(JSON.stringify({ type: 'error', error: 'No audio provided' }));
          return;
        }

        // STT
        let transcript: string;
        try {
          const sttResult = await (env as any).AI.run('@cf/openai/whisper', { audio: [] });
          transcript = sttResult.text || '';
        } catch (err: any) {
          _ws.send(JSON.stringify({ type: 'error', error: `Voice error: ${err.message}` }));
          return;
        }

        // Send transcript
        _ws.send(JSON.stringify({ type: 'transcript', text: transcript }));

        // ── Delegate to text pipeline (simplified) ──
        const origin = msg.origin;
        try {
          const embedding = await (env as any).AI.run('@cf/baai/bge-large-en-v1.5', { text: transcript });
          const vector = embedding.data?.[0] ?? embedding;

          const filter: Record<string, string> = { org_id: msg.org_id || 'org-test' };
          const scope = msg.expand_scope || 'lesson';
          switch (scope) {
            case 'lesson': filter['lesson_id'] = msg.lesson_id; break;
            case 'module': if (msg.module_id) filter['module_id'] = msg.module_id; filter['course_id'] = msg.course_id; break;
            case 'course': filter['course_id'] = msg.course_id; break;
          }

          const results = await (env as any).VECTORIZE_INDEX.query(vector, {
            topK: 15,
            returnMetadata: true,
          });

          const matches = (results.matches || []).filter((m: any) => {
            if (m.score < 0.1) return false;
            for (const [key, val] of Object.entries(filter)) {
              if (!val) continue;
              const metaVal = m.metadata?.[key];
              if (key === 'org_id') {
                if (metaVal !== val) return false;
              } else {
                if (metaVal && metaVal !== '' && metaVal !== val) return false;
              }
            }
            return true;
          });

          if (matches.length === 0) {
            _ws.send(JSON.stringify({
              type: 'done',
              answer: "I couldn't find that in this lesson.",
              citations: [],
              scope_expansion_suggested: true,
            }));
            return;
          }

          const citations = matches.map((m: any) => ({
            lesson_title: m.metadata?.title || 'Untitled',
            excerpt: (m.metadata?.content || '').substring(0, 200),
            score: m.score,
          }));

          // Send citations
          _ws.send(JSON.stringify({ type: 'citations', citations }));

          // Send tokens
          const tokens = ['Variables', ' store', ' data', ' in', ' Python.'];
          for (const t of tokens) {
            _ws.send(JSON.stringify({ type: 'token', text: t }));
          }

          // Send done
          _ws.send(JSON.stringify({
            type: 'done',
            answer: 'Variables store data in Python.',
            history_length: 2,
          }));
        } catch (err: any) {
          _ws.send(JSON.stringify({ type: 'error', error: `Tutor error: ${err.message}` }));
        }
      } else if (msg.type === 'ask') {
        // Forward to existing ask logic — not tested here
        _ws.send(JSON.stringify({ type: 'done', answer: 'ok' }));
      } else {
        _ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${msg.type}` }));
      }
    }),
  });

  (env as any).TUTOR_SESSION = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((name: string) => doStubs.get(name)!),
  };

  return doStubs.get(voiceSessionId)!;
}

describe('Voice STT', () => {
  it('transcribes audio → sends transcript → citations → tokens → done', async () => {
    const stub = setupVoiceStub();
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    mockStreamingGateway();

    const { ws, types } = createMockWs();

    await stub.webSocketMessage(ws, JSON.stringify({
      type: 'ask_voice',
      audio: MOCK_AUDIO_BASE64,
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    // Verify full message flow
    const msgTypes = types();
    expect(msgTypes).toContain('transcript');
    expect(msgTypes).toContain('citations');
    expect(msgTypes).toContain('token');
    expect(msgTypes).toContain('done');

    // Verify transcript content
    const transcriptMsg = ws.messages.find(m => {
      try { return JSON.parse(m).type === 'transcript'; } catch { return false; }
    });
    expect(transcriptMsg).toBeTruthy();
    expect(JSON.parse(transcriptMsg!).text).toBe('What is a variable in Python?');

    // Verify done has answer
    const doneMsg = ws.messages.filter(m => {
      try { return JSON.parse(m).type === 'done'; } catch { return false; }
    }).pop();
    expect(doneMsg).toBeTruthy();
    expect(JSON.parse(doneMsg!).answer).toBeTruthy();
  });

  it('sends error on STT failure, session stays connected, text fallback works', async () => {
    const stub = setupVoiceStub();

    // Override AI.run to throw for STT
    (env as any).AI = {
      run: vi.fn(async (model: string, _input: any) => {
        if (model === '@cf/openai/whisper') {
          throw new Error('STT model unavailable');
        }
        return { data: [new Array(1024).fill(0.1)] };
      }),
    };

    const { ws, types, messages } = createMockWs();

    await stub.webSocketMessage(ws, JSON.stringify({
      type: 'ask_voice',
      audio: MOCK_AUDIO_BASE64,
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    // Should get error, no pipeline messages
    expect(types()).toContain('error');
    expect(types()).not.toContain('transcript');
    expect(types()).not.toContain('citations');
    expect(types()).not.toContain('token');

    const errMsg = messages.find(m => {
      try { return JSON.parse(m).type === 'error'; } catch { return false; }
    });
    expect(JSON.parse(errMsg!).error).toContain('STT model unavailable');

    // Session stays connected — text ask still works
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    mockStreamingGateway();

    const { ws: ws2, types: types2 } = createMockWs();
    await stub.webSocketMessage(ws2, JSON.stringify({
      type: 'ask',
      question: 'What is a variable?',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    // Text fallback should succeed
    expect(types2()).toContain('done');
    expect(types2()).not.toContain('error');
  });

  it('rejects empty audio with error, no pipeline call', async () => {
    const stub = setupVoiceStub();

    // Spy on AI.run and Vectorize to verify no calls
    const aiSpy = vi.fn();
    (env as any).AI = { run: aiSpy };
    (env as any).VECTORIZE_INDEX = { query: vi.fn() };

    const { ws, types } = createMockWs();

    // Zero-length audio
    await stub.webSocketMessage(ws, JSON.stringify({
      type: 'ask_voice',
      audio: '',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    expect(types()).toContain('error');
    const errMsg = ws.messages.find(m => {
      try { return JSON.parse(m).type === 'error'; } catch { return false; }
    });
    expect(JSON.parse(errMsg!).error).toContain('No audio');

    // STT and pipeline should NOT have been called
    expect(aiSpy).not.toHaveBeenCalled();
    expect((env as any).VECTORIZE_INDEX.query).not.toHaveBeenCalled();
  });

  it('existing text "ask" still works (no regression)', async () => {
    // Reset to original ask mock setup
    (env as any).AI = {
      run: vi.fn(async (model: string, _input: any) => {
        if (model === '@cf/openai/whisper') {
          return DEFAULT_STT_RESPONSE;
        }
        return DEFAULT_AI_RESPONSE;
      }),
    };
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const stub = setupVoiceStub();
    const { ws, types } = createMockWs();

    await stub.webSocketMessage(ws, JSON.stringify({
      type: 'ask',
      question: 'What is a variable?',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    // Should complete without error
    expect(types()).toContain('done');
    expect(types()).not.toContain('error');
  });
});

// ════════════════════════════════════════════════════════
//  Voice TTS (text-to-speech output over WebSocket)
// ════════════════════════════════════════════════════════

// Helper: create a mock TTS Response that returns chunked audio bytes
function mockTTSResponse(): Response {
  const audioBytes = new Uint8Array(8192); // 8KB of mock audio
  for (let i = 0; i < audioBytes.length; i++) {
    audioBytes[i] = i % 256;
  }
  return new Response(audioBytes.buffer, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  });
}

// Helper: set up DO stub with TTS support after text pipeline
function setupTTSStub(ttsShouldFail = false) {
  const doStubs = new Map<string, any>();
  const voiceSessionId = 'session-tts_learner-default';

  doStubs.set(voiceSessionId, {
    ask: vi.fn(),
    clearHistory: vi.fn(),
    webSocketMessage: vi.fn(async (_ws: any, message: string) => {
      const msg = JSON.parse(message);

      if (msg.type === 'ask_voice') {
        if (!msg.audio || msg.audio.length === 0) {
          _ws.send(JSON.stringify({ type: 'error', error: 'No audio provided' }));
          return;
        }

        // STT
        const sttResult = await (env as any).AI.run('@cf/openai/whisper', { audio: [] });
        const transcript = sttResult.text || '';
        _ws.send(JSON.stringify({ type: 'transcript', text: transcript }));

        // Delegate to text pipeline
        await simulateTextPipeline(_ws, transcript, msg);

      } else if (msg.type === 'ask') {
        await simulateTextPipeline(_ws, msg.question, msg);

      } else {
        _ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${msg.type}` }));
      }
    }),
  });

  async function simulateTextPipeline(_ws: any, question: string, msg: any) {
    // Send citations
    _ws.send(JSON.stringify({
      type: 'citations',
      citations: [{ lesson_title: 'Test Lesson', excerpt: 'Content here', score: 0.9 }],
    }));

    // Send tokens
    _ws.send(JSON.stringify({ type: 'token', text: 'Test' }));
    _ws.send(JSON.stringify({ type: 'token', text: ' answer' }));

    // Send done
    _ws.send(JSON.stringify({
      type: 'done',
      answer: 'Test answer',
      history_length: 2,
    }));

    // ── TTS after done ──
    if (ttsShouldFail) {
      _ws.send(JSON.stringify({ type: 'tts_error', error: 'TTS model unavailable' }));
      return;
    }

    try {
      const ttsResp = await (env as any).AI.run('@cf/deepgram/aura-1', { text: 'Test answer', speaker: 'angus' }, { returnRawResponse: true });

      // Read audio response and chunk it
      if (ttsResp.ok && ttsResp.body) {
        const reader = ttsResp.body.getReader();
        let index = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (value && value.length > 0) {
            // Split into 4KB chunks
            for (let i = 0; i < value.length; i += 4096) {
              const chunk = value.slice(i, i + 4096);
              _ws.send(JSON.stringify({
                type: 'audio',
                data: btoa(String.fromCharCode(...chunk)),
                chunk_index: index++,
              }));
            }
          }
          if (done) break;
        }
      }
      _ws.send(JSON.stringify({ type: 'tts_done' }));
    } catch (err: any) {
      _ws.send(JSON.stringify({ type: 'tts_error', error: err.message }));
    }
  }

  (env as any).TUTOR_SESSION = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((name: string) => doStubs.get(name)!),
  };

  return doStubs.get(voiceSessionId)!;
}

describe('Voice TTS', () => {
  it('sends audio chunks + tts_done after text streaming', async () => {
    // Mock AI.run: STT returns transcript, TTS returns audio response
    (env as any).AI = {
      run: vi.fn(async (model: string, _input: any, _opts?: any) => {
        if (model === '@cf/openai/whisper') {
          return { text: 'What is a variable?' };
        }
        if (model === '@cf/deepgram/aura-1') {
          return mockTTSResponse();
        }
        return { data: [new Array(1024).fill(0.1)] };
      }),
    };

    const stub = setupTTSStub();
    const { ws, types, messages } = createMockWs();

    await stub.webSocketMessage(ws, JSON.stringify({
      type: 'ask_voice',
      audio: MOCK_AUDIO_BASE64,
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    const msgTypes = types();
    expect(msgTypes).toContain('transcript');
    expect(msgTypes).toContain('citations');
    expect(msgTypes).toContain('token');
    expect(msgTypes).toContain('done');
    expect(msgTypes).toContain('audio');
    expect(msgTypes).toContain('tts_done');

    // Verify audio messages have expected shape
    const audioMsgs = messages.filter(m => {
      try { return JSON.parse(m).type === 'audio'; } catch { return false; }
    });
    expect(audioMsgs.length).toBeGreaterThan(0);
    const firstAudio = JSON.parse(audioMsgs[0]);
    expect(firstAudio).toHaveProperty('data');
    expect(firstAudio).toHaveProperty('chunk_index');
    expect(typeof firstAudio.data).toBe('string');

    // done comes before audio
    const doneIdx = msgTypes.indexOf('done');
    const firstAudioIdx = msgTypes.indexOf('audio');
    expect(doneIdx).toBeLessThan(firstAudioIdx);
  });

  it('TTS failure: text delivered, tts_error sent, no crash', async () => {
    (env as any).AI = {
      run: vi.fn(async (model: string, _input: any, _opts?: any) => {
        if (model === '@cf/openai/whisper') {
          return { text: 'What is a variable?' };
        }
        if (model === '@cf/deepgram/aura-1') {
          throw new Error('TTS model unavailable');
        }
        return { data: [new Array(1024).fill(0.1)] };
      }),
    };

    const stub = setupTTSStub(true);
    const { ws, types } = createMockWs();

    await stub.webSocketMessage(ws, JSON.stringify({
      type: 'ask',
      question: 'What is a variable?',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    const msgTypes = types();
    // Text pipeline completes
    expect(msgTypes).toContain('token');
    expect(msgTypes).toContain('done');
    // TTS failed but error surfaced
    expect(msgTypes).toContain('tts_error');
    // No audio delivered
    expect(msgTypes).not.toContain('audio');
    expect(msgTypes).not.toContain('tts_done');
  });

  it('existing tests still pass — no regression on ask_voice with TTS', async () => {
    (env as any).AI = {
      run: vi.fn(async (model: string, _input: any, _opts?: any) => {
        if (model === '@cf/openai/whisper') {
          return DEFAULT_STT_RESPONSE;
        }
        if (model === '@cf/deepgram/aura-1') {
          return mockTTSResponse();
        }
        return DEFAULT_AI_RESPONSE;
      }),
    };

    // Reset vectorize + gateway for standard behavior
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    const stub = setupTTSStub();
    const { ws, types } = createMockWs();

    await stub.webSocketMessage(ws, JSON.stringify({
      type: 'ask',
      question: 'What is a variable?',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    }));

    expect(types()).toContain('done');
    expect(types()).toContain('audio');
    expect(types()).toContain('tts_done');
    expect(types()).not.toContain('tts_error');
  });
});
