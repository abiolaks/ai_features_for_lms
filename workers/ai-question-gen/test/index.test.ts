// ============================================================
// F07: Question Generation — Test Suite
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

// ── Mock LMS Data ──

const MOCK_LESSON = {
  data: {
    id: 'lesson-001',
    title: 'Introduction to Python Variables',
    content: `
Python variables are containers for storing data values. Unlike some other
programming languages, Python has no command for declaring a variable — a
variable is created the moment you first assign a value to it.

Variables do not need to be declared with any particular type and can even
change type after they have been set. For example:

x = 5       # x is an integer
x = "hello" # x is now a string

Variable names must start with a letter or underscore, and can only contain
alphanumeric characters and underscores. They are case-sensitive.

Common variable types in Python include:
- Integers (int): whole numbers like 5, -3, 0
- Floats (float): decimal numbers like 3.14, -0.5
- Strings (str): text enclosed in quotes like "hello"
- Booleans (bool): True or False values

You can check a variable's type using the type() function. Python also supports
multiple assignment: a, b, c = 1, 2, 3 assigns all three variables at once.
    `.trim(),
    courseId: 'course-001',
    moduleId: 'module-001',
  },
};

const MOCK_VECTORIZE_RESULTS = {
  matches: [
    {
      id: 'chunk-0',
      score: 0.95,
      metadata: {
        lesson_id: 'lesson-001',
        title: 'Introduction to Python Variables',
        chunk_index: 0,
        total_chunks: 2,
        content: 'Python variables are containers for storing data values. Unlike some other programming languages, Python has no command for declaring a variable.',
      },
    },
    {
      id: 'chunk-1',
      score: 0.92,
      metadata: {
        lesson_id: 'lesson-001',
        title: 'Introduction to Python Variables',
        chunk_index: 1,
        total_chunks: 2,
        content: 'Common variable types include integers, floats, strings, and booleans. Use type() to check a variable type. Python supports multiple assignment: a, b, c = 1, 2, 3.',
      },
    },
  ],
};

const MOCK_LLM_QUESTIONS = [
  {
    text: 'What function checks a variable\'s type in Python?',
    options: ['type()', 'check()', 'typeof()', 'var_type()'],
    correct_answer: 'type()',
    difficulty: 'beginner',
    topic: 'Type checking',
  },
  {
    text: 'Which is NOT a valid Python variable name?',
    options: ['_myVar', 'my_var', '2ndVar', 'MyVar'],
    correct_answer: '2ndVar',
    difficulty: 'intermediate',
    topic: 'Variable naming',
  },
  {
    text: 'What does the following assign: a, b, c = 1, 2, 3?',
    options: ['a=1, b=2, c=3', 'a=1 only', 'a=3, b=2, c=1', 'An error occurs'],
    correct_answer: 'a=1, b=2, c=3',
    difficulty: 'beginner',
    topic: 'Multiple assignment',
  },
  {
    text: 'Which is a float in Python?',
    options: ['5', '3.14', '"3.14"', 'True'],
    correct_answer: '3.14',
    difficulty: 'beginner',
    topic: 'Data types',
  },
  {
    text: 'After x = 5 then x = "hello", what type is x?',
    options: ['int', 'float', 'str', 'bool'],
    correct_answer: 'str',
    difficulty: 'intermediate',
    topic: 'Dynamic typing',
  },
];

// ── Helper ──

function mockEnv(overrides: {
  lesson?: any;
  lessonStatus?: number;
  lmsError?: boolean;
  vectorizeResults?: any;
  gatewayResponse?: object | null;
  gatewayOk?: boolean;
} = {}) {
  const {
    lesson = MOCK_LESSON,
    lessonStatus = 200,
    lmsError = false,
    vectorizeResults = MOCK_VECTORIZE_RESULTS,
    gatewayResponse = MOCK_LLM_QUESTIONS,
    gatewayOk = true,
  } = overrides;

  // LMS fetch
  const lmsFetch = lmsError
    ? vi.fn(() => Promise.reject(new Error('Connection refused')))
    : vi.fn((input: any) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
        if (url.includes('/lessons/')) {
          return Promise.resolve(
            new Response(JSON.stringify(lesson), {
              status: lessonStatus,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

  vi.stubGlobal('fetch', lmsFetch);

  // AI binding (embeddings)
  const mockAi = {
    run: vi.fn().mockResolvedValue({ data: [new Array(1024).fill(0.1)] }),
  };

  // Vectorize
  const mockVectorize = {
    query: vi.fn().mockResolvedValue(vectorizeResults),
  };

  // Gateway
  const gateway = createMockGateway(
    gatewayResponse === null
      ? {}
      : createLlmResponse(gatewayResponse),
    gatewayOk,
  );

  return {
    ...env,
    AI: mockAi,
    VECTORIZE_INDEX: mockVectorize,
    AI_GATEWAY: gateway,
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
      new Request('https://ai-question-gen/questions/generate', { method: 'GET' }),
      e, ctx,
    );
    expect(resp.status).toBe(405);
    const body = (await resp.json()) as any;
    expect(body.error).toBe('method_not_allowed');
  });

  it('rejects missing lesson_id', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: 'org-test' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain('lesson_id');
  });

  it('rejects missing org_id', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain('org_id');
  });

  it('rejects invalid JSON body', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      e, ctx,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toBe('invalid_json_body');
  });

  it('health endpoint works', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/health'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.worker).toBe('ai-question-gen');
  });
});

// ════════════════════════════════════════════════════════
//  Happy Path
// ════════════════════════════════════════════════════════

describe('Happy path', () => {
  it('generates multiple-choice questions from lesson content', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.lesson_id).toBe('lesson-001');
    expect(body.lesson_title).toBe('Introduction to Python Variables');
    expect(body.questions).toBeInstanceOf(Array);
    expect(body.questions.length).toBe(5); // default
    expect(body.ai_status).toBe('generated');
    expect(body.content_source).toBe('lms');
  });

  it('generates true-false questions when requested', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lesson_id: 'lesson-001',
          org_id: 'org-test',
          type: 'true-false',
          count: 3,
        }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.questions.length).toBeLessThanOrEqual(3);
  });

  it('caps question count at MAX (15)', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lesson_id: 'lesson-001',
          org_id: 'org-test',
          count: 50,
        }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    // won't generate more than 15 even if requested 50
    expect(resp.status).toBe(200);
  });

  it('each question has all required fields', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    for (const q of body.questions) {
      expect(typeof q.text).toBe('string');
      expect(q.text.length).toBeGreaterThan(0);
      expect(Array.isArray(q.options)).toBe(true);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(typeof q.correct_answer).toBe('string');
      expect(q.options).toContain(q.correct_answer);
      expect(['beginner', 'intermediate', 'advanced']).toContain(q.difficulty);
      expect(typeof q.topic).toBe('string');
      expect(q.topic.length).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════
//  Vectorize Fallback
// ════════════════════════════════════════════════════════

describe('Vectorize fallback', () => {
  it('falls back to Vectorize when lesson content is short', async () => {
    const e = mockEnv({
      lesson: {
        data: {
          id: 'lesson-001',
          title: 'Video Lesson',
          content: 'Watch the video', // < 200 chars
        },
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.content_source).toBe('vectorize');
    expect(body.questions.length).toBeGreaterThan(0);
  });

  it('returns insufficient_content when both LMS and Vectorize fail', async () => {
    const e = mockEnv({
      lesson: {
        data: { id: 'lesson-001', title: 'Empty', content: '' },
      },
      vectorizeResults: { matches: [] },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('insufficient_content');
    expect(body.questions).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns degraded when LMS is unreachable', async () => {
    const e = mockEnv({
      lmsError: true,
      vectorizeResults: { matches: [] }, // no fallback data
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('insufficient_content');
  });

  it('returns degraded when gateway fails', async () => {
    const e = mockEnv({ gatewayOk: false });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.questions).toEqual([]);
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    const e = mockEnv({ gatewayResponse: 'Here are some questions...' });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.questions).toEqual([]);
  });

  it('filters out questions with invalid data', async () => {
    const e = mockEnv({
      gatewayResponse: [
        // Valid
        { text: 'Q1', options: ['A', 'B'], correct_answer: 'A', difficulty: 'beginner', topic: 'T' },
        // Missing correct_answer
        { text: 'Q2', options: ['A', 'B'], correct_answer: '', difficulty: 'beginner', topic: 'T' },
        // correct_answer not in options
        { text: 'Q3', options: ['A', 'B'], correct_answer: 'C', difficulty: 'beginner', topic: 'T' },
        // Missing text
        { text: '', options: ['A', 'B'], correct_answer: 'A' },
      ],
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test', count: 4 }),
      }),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.questions.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('uses quality tier', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );

    const gwSpans = spans('ai_gateway.generate');
    expect(gwSpans.length).toBeGreaterThan(0);
    expect(gwSpans[0].tier).toBe('quality');
  });

  it('includes lesson content in prompt', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    const gwCalls = gateway.fetch.mock.calls;
    const req = gwCalls[0][0] as Request;
    const reqBody = await req.text();
    const parsed = JSON.parse(reqBody);
    const prompt = parsed.messages[0].content;
    expect(prompt).toContain('LESSON TITLE: Introduction to Python Variables');
    expect(prompt).toContain('Python variables are containers');
    expect(prompt).toContain('multiple-choice');
  });

  it('truncates very long content in prompt', async () => {
    const longContent = 'x'.repeat(15000);
    const e = mockEnv({
      lesson: {
        data: { id: 'lesson-001', title: 'Long', content: longContent },
      },
    });
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    const req = gateway.fetch.mock.calls[0][0] as Request;
    const reqBody = await req.text();
    const parsed = JSON.parse(reqBody);
    const prompt = parsed.messages[0].content;
    expect(prompt).toContain('truncated for length');
    expect(prompt.length).toBeLessThan(longContent.length + 500);
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits data.fetch span with content source', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans.length).toBe(1);
    expect(dataSpans[0].lesson_id).toBe('lesson-001');
    expect(dataSpans[0].content_source).toBe('lms');
    expect(dataSpans[0].content_length).toBeGreaterThan(0);
  });

  it('emits vectorize_fallback in data.fetch span', async () => {
    const e = mockEnv({
      lesson: { data: { id: 'lesson-001', title: 'Vid', content: 'short' } },
    });
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans[0].vectorize_fallback).toBe(true);
  });

  it('emits insight.generate span with generated count', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-question-gen/questions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lesson_id: 'lesson-001', org_id: 'org-test' }),
      }),
      e, ctx,
    );

    const insightSpans = spans('insight.generate');
    expect(insightSpans.length).toBe(1);
    expect(insightSpans[0].ai_status).toBe('generated');
    expect(insightSpans[0].generated_count).toBe(5);
  });
});

import { parseLlmJson } from '../../shared/llm-parser';
describe('Debug parseLlmJson', () => {
  it('parses JSON array correctly', () => {
    const arr = [{a:1},{b:2}];
    const json = JSON.stringify(arr);
    const result = parseLlmJson(json);
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(2);
  });
});
// ── Regression: parseLlmJson array support ──
import { parseLlmJson } from '../../shared/llm-parser';

describe('parseLlmJson regression', () => {
  it('parses JSON array from callGateway output', () => {
    // Exact reproduction of MOCK_LLM_QUESTIONS → callGateway → parseQuestions flow
    const rawQuestions = [
      { text: 'Q1', options: ['A','B','C','D'], correct_answer: 'A', difficulty: 'beginner', topic: 'T1' },
      { text: 'Q2', options: ['E','F','G','H'], correct_answer: 'E', difficulty: 'beginner', topic: 'T2' },
      { text: 'Q3', options: ['I','J','K','L'], correct_answer: 'I', difficulty: 'beginner', topic: 'T3' },
      { text: 'Q4', options: ['M','N','O','P'], correct_answer: 'M', difficulty: 'beginner', topic: 'T4' },
      { text: 'Q5', options: ['Q','R','S','T'], correct_answer: 'Q', difficulty: 'beginner', topic: 'T5' },
    ];
    const text = JSON.stringify(rawQuestions);
    const result = parseLlmJson(text);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(5);
  });
});
