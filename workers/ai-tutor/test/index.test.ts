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
    run: vi.fn().mockResolvedValue(DEFAULT_AI_RESPONSE),
  };
  (env as any).VECTORIZE_INDEX = {
    query: mockVectorizeQuery([]),
  };
  (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
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

  it('rejects missing lesson_id', async () => {
    const res = await ask({ question: 'q', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('lesson_id');
  });

  it('rejects missing org_id', async () => {
    const res = await ask({ question: 'q', lesson_id: 'l1' });
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
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    expect(gatewaySpy).toHaveBeenCalled();
    const callBody = JSON.parse(await gatewaySpy.mock.calls[0][0].text());
    const prompt = callBody.messages[0].content;

    expect(prompt).toContain('based on the provided content');
    expect(prompt).toContain('[Lesson: Python Variables]');
    expect(prompt).toContain('QUESTION: What is X?');
  });

  it('handles gateway errors gracefully', async () => {
    (env as any).VECTORIZE_INDEX.query = mockVectorizeQuery([
      matchingChunk({ lesson_id: 'l1', org_id: 'org-test' }),
    ]);
    (env as any).AI_GATEWAY = mockAiGateway({}, false);

    const res = await ask({
      question: 'q',
      lesson_id: 'l1',
      course_id: 'course-1',
      org_id: 'org-test',
    });

    expect(res.status).toBe(502);
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
