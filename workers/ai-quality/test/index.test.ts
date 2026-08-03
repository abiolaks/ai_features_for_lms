// ============================================================
// F08: Quality Checks — Test Suite
// ============================================================

import {
  describe, it, expect, vi,
} from 'vitest';
import {
  env,
  createExecutionContext,
} from 'cloudflare:test';
import { createMockGateway, createLlmResponse, spyOnSpans } from '../../shared/test-utils';
import worker from '../src/index';

// ── Mock Data ──

const MOCK_QUESTIONS = [
  {
    text: 'What function checks a variable type in Python?',
    options: ['type()', 'check()', 'typeof()', 'var_type()'],
    correct_answer: 'type()',
    difficulty: 'beginner',
    topic: 'Type checking',
    source_content: 'Python variables are containers for storing data. You can check a variable\'s type using the type() function.',
  },
  {
    text: 'Which is NOT a valid Python variable name?',
    options: ['_myVar', 'my_var', '2ndVar', 'MyVar'],
    correct_answer: '2ndVar',
    difficulty: 'intermediate',
    topic: 'Variable naming',
    source_content: 'Variable names must start with a letter or underscore, and can only contain alphanumeric characters and underscores.',
  },
  {
    text: 'What is the capital of France?',
    options: ['Paris', 'London', 'Berlin', 'Madrid'],
    correct_answer: 'Paris',
    difficulty: 'beginner',
    topic: 'Geography',
    source_content: 'Python is a programming language used for web development, data science, and automation.',
  },
];

const MOCK_LLM_RESULTS = [
  { passed: true, issues: [], suggestions: [] },
  { passed: true, issues: [], suggestions: [] },
  { passed: false, issues: ['Hallucinated answer — source does not mention France'], suggestions: ['Replace with a question answerable from the source content'] },
];

// ── Helper ──

let callIndex = 0;

function mockEnv(overrides: {
  gatewayResponses?: object[];
  gatewayOk?: boolean;
} = {}) {
  const {
    gatewayResponses = MOCK_LLM_RESULTS,
    gatewayOk = true,
  } = overrides;

  callIndex = 0;
  const mockGateway = {
    fetch: vi.fn(() => {
      const idx = callIndex++;
      const payload = gatewayResponses[idx] || gatewayResponses[0];
      const resp = createLlmResponse(payload);
      return Promise.resolve(
        new Response(JSON.stringify(resp), {
          status: gatewayOk ? 200 : 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  };

  return {
    ...env,
    AI_GATEWAY: mockGateway,
  };
}

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects non-POST methods', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', { method: 'GET' }),
      e, ctx,
    );
    expect(resp.status).toBe(405);
    const body = (await resp.json()) as any;
    expect(body.error).toBe('method_not_allowed');
  });

  it('rejects missing questions array', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain('questions');
  });

  it('rejects empty questions array', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: [] }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toBe('empty_questions_array');
  });

  it('rejects batch too large', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const largeBatch = Array.from({ length: 25 }, (_, i) => ({
      text: `Q${i}`, options: ['A', 'B'], correct_answer: 'A',
      difficulty: 'beginner', topic: 'T', source_content: 'content',
    }));
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: largeBatch }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain('batch_too_large');
  });

  it('health endpoint works', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/health'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.worker).toBe('ai-quality');
  });
});

// ════════════════════════════════════════════════════════
//  Happy Path
// ════════════════════════════════════════════════════════

describe('Happy path', () => {
  it('validates all questions and returns per-question results', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.total).toBe(3);
    expect(body.passed).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results).toBeInstanceOf(Array);
    expect(body.results.length).toBe(3);
    expect(body.ai_status).toBe('generated');
  });

  it('each result has required fields', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS }),
      }),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    for (let i = 0; i < body.results.length; i++) {
      const r = body.results[i];
      expect(r.question_index).toBe(i);
      expect(typeof r.passed).toBe('boolean');
      expect(Array.isArray(r.issues)).toBe(true);
      expect(Array.isArray(r.suggestions)).toBe(true);
    }
  });

  it('marks hallucinated questions as failed with issues', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS }),
      }),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    // Question 2 is hallucinated (geography question with Python source)
    const q2 = body.results[2];
    expect(q2.passed).toBe(false);
    expect(q2.issues.length).toBeGreaterThan(0);
    expect(q2.issues[0]).toMatch(/hallucin|source/i);
  });

  it('marks valid questions as passed with no issues', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS.slice(0, 2) }),
      }),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.passed).toBe(2);
    expect(body.failed).toBe(0);
  });

  it('truncates long source content in prompt', async () => {
    const longSource = 'x'.repeat(6000);
    const e = mockEnv();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: [{
            ...MOCK_QUESTIONS[0],
            source_content: longSource,
          }],
        }),
      }),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    const req = gateway.fetch.mock.calls[0][0] as Request;
    const reqBody = await req.text();
    const parsed = JSON.parse(reqBody);
    const prompt = parsed.messages[0].content;
    expect(prompt).toContain('truncated');
  });
});

// ════════════════════════════════════════════════════════
//  Missing Fields
// ════════════════════════════════════════════════════════

describe('Missing fields', () => {
  it('flags questions with missing source_content', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: [{
            text: 'Q', options: ['A', 'B'], correct_answer: 'A',
            difficulty: 'beginner', topic: 'T',
            source_content: '',
          }],
        }),
      }),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.results[0].passed).toBe(false);
    expect(body.results[0].issues[0]).toContain('Missing required fields');
  });

  it('flags questions with missing text', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: [{
            text: '', options: ['A', 'B'], correct_answer: 'A',
            difficulty: 'beginner', topic: 'T',
            source_content: 'content',
          }],
        }),
      }),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.results[0].passed).toBe(false);
    expect(body.results[0].issues[0]).toContain('Missing required fields');
  });

  it('does not call gateway for invalid questions', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: [{
            text: '', options: [], correct_answer: '', difficulty: '', topic: '',
            source_content: '',
          }],
        }),
      }),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    expect(gateway.fetch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns skeleton results when gateway fails', async () => {
    const e = mockEnv({ gatewayOk: false });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS.slice(0, 1) }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.passed).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0].issues[0]).toContain('Gateway unavailable');
  });

  it('returns partial when some gateway calls fail', async () => {
    const e = mockEnv({
      gatewayResponses: [
        { passed: true, issues: [], suggestions: [] }, // first succeeds
        // second and third get default (also succeed with mock)
      ],
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS }),
      }),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('generated');
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    const e = mockEnv({
      gatewayResponses: ['This question looks fine to me.'],
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS.slice(0, 1) }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.results[0].passed).toBe(false);
    expect(body.results[0].issues[0]).toContain('parse');
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('uses standard tier', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS.slice(0, 1) }),
      }),
      e, ctx,
    );

    const gwSpans = spans('ai_gateway.generate');
    expect(gwSpans.length).toBeGreaterThan(0);
    expect(gwSpans[0].tier).toBe('standard');
  });

  it('includes source content and question in prompt', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS.slice(0, 1) }),
      }),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    const req = gateway.fetch.mock.calls[0][0] as Request;
    const reqBody = await req.text();
    const parsed = JSON.parse(reqBody);
    const prompt = parsed.messages[0].content;
    expect(prompt).toContain('Python variables are containers');
    expect(prompt).toContain('type()');
    expect(prompt).toContain('ACCURACY');
    expect(prompt).toContain('BIAS');
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits insight.generate span with pass/fail counts', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS }),
      }),
      e, ctx,
    );

    const insightSpans = spans('insight.generate');
    expect(insightSpans.length).toBe(1);
    expect(insightSpans[0].question_count).toBe(3);
    expect(insightSpans[0].total).toBe(3);
    expect(insightSpans[0].passed).toBe(2);
    expect(insightSpans[0].failed).toBe(1);
    expect(insightSpans[0].ai_status).toBe('generated');
  });

  it('emits ai_gateway.generate sub-span per question', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-quality/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: MOCK_QUESTIONS }),
      }),
      e, ctx,
    );

    const gwSpans = spans('ai_gateway.generate');
    expect(gwSpans.length).toBe(3);
    expect(gwSpans[0].question_index).toBe(0);
    expect(gwSpans[1].question_index).toBe(1);
    expect(gwSpans[2].question_index).toBe(2);
  });
});
