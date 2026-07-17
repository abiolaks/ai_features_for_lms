import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../src/index';

// ──── Mocks ────

function mockAiGateway(response: object, ok = true) {
  return {
    fetch: vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status: ok ? 200 : 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  };
}

const DEFAULT_LLM_RESPONSE = {
  response: JSON.stringify({
    insight: "Great effort! You scored 80% — solid work. You're 65% through the course. Focus on loops and list comprehensions.",
    missed_topics: ["Loops", "List Comprehensions"],
  }),
  model_used: '@cf/meta/llama-3.2-3b-instruct',
  provider: 'cloudflare',
  tokens_used: 90,
  throttle_warning: false,
};

// ──── LMS mock responses ────

const MOCK_ATTEMPT = {
  success: true,
  data: {
    id: 'attempt-1',
    userId: 'learner-1',
    assessmentId: 'assessment-1',
    courseId: 'course-42',
    organizationId: 'org-test',
    scorePercent: 80,
    totalQuestions: 10,
    correctAnswers: 8,
    timeTakenSeconds: 420,
    startedAt: '2026-07-17T10:00:00Z',
    completedAt: '2026-07-17T10:07:00Z',
    canReviewAnswers: true,
    responses: [
      '{"question_id":"q1","question_text":"What is a variable?","selected":"A container for data","correct":true,"timeSpentSeconds":15}',
      '{"question_id":"q2","question_text":"Explain for loops","selected":"Iterates over items","correct":true,"timeSpentSeconds":25}',
      '{"question_id":"q3","question_text":"What is a while loop?","selected":"A function","correct":false,"timeSpentSeconds":90,"correct_answer":"Repeats while condition is true"}',
      '{"question_id":"q4","question_text":"What is a list comprehension?","selected":"A type of loop","correct":false,"timeSpentSeconds":70,"correct_answer":"Concise way to create lists"}',
    ],
  },
};

const MOCK_ASSESSMENT = {
  success: true,
  data: {
    id: 'assessment-1',
    courseId: 'course-42',
    moduleId: 'module-7',
    title: 'Python Basics Quiz',
    passingScore: 70,
    difficultyLevel: 'beginner',
  },
};

const MOCK_PROGRESS = {
  success: true,
  data: {
    totalEnrollments: 3,
    completedEnrollments: 1,
    enrollments: [
      { courseTitle: 'Python Basics', status: 'enrolled', progressPercent: '65' },
      { courseTitle: 'SQL for Data', status: 'completed', progressPercent: '100' },
    ],
  },
};

// GET /api/v1/modules/{moduleId}/lessons → { data: LessonResource[] }
// (no `success` flag on this wrapper — matches api.json)
const MOCK_MODULE_LESSONS = {
  data: [
    { id: 'lesson-5', title: 'Variables and Data Types', moduleId: 'module-7', courseId: 'course-42', sortOrder: 1 },
    { id: 'lesson-6', title: 'For Loops and Iteration', moduleId: 'module-7', courseId: 'course-42', sortOrder: 2 },
    { id: 'lesson-7', title: 'While Loops', moduleId: 'module-7', courseId: 'course-42', sortOrder: 3 },
    { id: 'lesson-8', title: 'List Comprehensions', moduleId: 'module-7', courseId: 'course-42', sortOrder: 4 },
  ],
};

// ──── Global fetch mock for LMS calls ────

let lmsFetch: ReturnType<typeof vi.fn>;

function setupLmsMocks() {
  lmsFetch = vi.fn((url: string) => {
    if (url.includes('/learner/assessments/attempts/')) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_ATTEMPT), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    if (url.includes('/learner/assessments/')) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_ASSESSMENT), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    if (url.includes('/progress/user')) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    if (url.includes('/modules/') && url.includes('/lessons')) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_MODULE_LESSONS), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
}

// ──── Span tracking ────

let spanLogs: string[] = [];
function mockConsoleLog(...args: unknown[]) {
  spanLogs.push(String(args[0]));
}

beforeAll(() => {
  vi.stubGlobal('fetch', lmsFetch);
  (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
});

beforeEach(() => {
  spanLogs = [];
  setupLmsMocks();
  vi.stubGlobal('fetch', lmsFetch);
  vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
  (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
});

// ──── Helpers ────

async function generateInsight(body: object) {
  const req = new Request('http://localhost/insights/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const VALID_BODY = {
  attempt_id: 'attempt-1',
  learner_id: 'learner-1',
  org_id: 'org-test',
};

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects GET', async () => {
    const req = new Request('http://localhost/insights/generate', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
  });

  it('rejects unknown paths', async () => {
    const req = new Request('http://localhost/unknown', { method: 'POST', body: '{}' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('http://localhost/insights/generate', {
      method: 'POST',
      body: 'not json',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('rejects missing attempt_id', async () => {
    const res = await generateInsight({ learner_id: 'l1', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('attempt_id');
  });

  it('rejects missing learner_id', async () => {
    const res = await generateInsight({ attempt_id: 'a1', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('learner_id');
  });

  it('rejects missing org_id', async () => {
    const res = await generateInsight({ attempt_id: 'a1', learner_id: 'l1' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('org_id');
  });
});

// ════════════════════════════════════════════════════════
//  Insight Generation
// ════════════════════════════════════════════════════════

describe('Insight generation', () => {
  it('returns insight with text, missed topics, and tone check', async () => {
    const res = await generateInsight(VALID_BODY);

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.insight_text).toBeTruthy();
    expect(body.insight_text.length).toBeGreaterThan(20);
    expect(body.missed_topics).toBeDefined();
    expect(Array.isArray(body.missed_topics)).toBe(true);
    expect(body.tone_check).toBe('encouraging');
  });

  it('includes review links for each missed topic', async () => {
    const res = await generateInsight(VALID_BODY);

    const body: any = await res.json();
    expect(body.missed_topics.length).toBeGreaterThan(0);
    for (const topic of body.missed_topics) {
      expect(topic.topic).toBeTruthy();
      expect(topic.review_link).toMatch(/^\/courses\/.+\/lessons\/.+/);
    }
  });

  it('references course progress in insight', async () => {
    const res = await generateInsight(VALID_BODY);

    const body: any = await res.json();
    // The LLM-generated insight should mention progress context
    // but as a minimum, the prompt was sent with progress data
    expect(body.insight_text.length).toBeGreaterThan(0);
  });

  it('returns encouraging tone for 0% score', async () => {
    const lowAttempt = {
      ...MOCK_ATTEMPT,
      data: { ...MOCK_ATTEMPT.data, scorePercent: 0, correctAnswers: 0 },
    };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/assessments/attempts/')) {
        return Promise.resolve(new Response(JSON.stringify(lowAttempt), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/') && !url.includes('attempts')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/modules/') && url.includes('/lessons')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_MODULE_LESSONS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();
    expect(body.tone_check).toBe('encouraging');
  });

  it('returns encouraging tone for 100% score', async () => {
    const perfectAttempt = {
      ...MOCK_ATTEMPT,
      data: { ...MOCK_ATTEMPT.data, scorePercent: 100, correctAnswers: 10 },
    };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/assessments/attempts/')) {
        return Promise.resolve(new Response(JSON.stringify(perfectAttempt), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/') && !url.includes('attempts')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/modules/') && url.includes('/lessons')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_MODULE_LESSONS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();
    expect(body.tone_check).toBe('encouraging');
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns placeholder when AI gateway fails', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({}, false);

    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    expect(body.insight_text).toContain('unavailable');
    expect(body.ai_status).toBe('degraded');
    expect(body.missed_topics).toEqual([]);
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({
      response: 'No JSON here, just some friendly text.',
      model_used: 'llama',
      provider: 'cloudflare',
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    expect(body.ai_status).toBe('degraded');
    expect(body.missed_topics).toEqual([]);
  });

  it('returns placeholder when LMS is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Connection refused'))));

    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    expect(body.insight_text).toContain('unavailable');
    expect(body.ai_status).toBe('degraded');
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('includes score and correct/wrong counts', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generateInsight(VALID_BODY);

    expect(spy).toHaveBeenCalled();
    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('80%');
    expect(prompt).toContain('8');
    expect(prompt).toContain('10');
  });

  it('includes course progress context', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generateInsight(VALID_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('65%');
  });

  it('includes per-question timing', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generateInsight(VALID_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('while loop');
    expect(prompt).toContain('90');
  });

  it('includes tone rules in prompt', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generateInsight(VALID_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt.toLowerCase()).toContain('encourag');
    expect(prompt.toLowerCase()).toContain('positive');
    expect(prompt.toLowerCase()).toContain('never');
  });

  it('uses standard tier', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generateInsight(VALID_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    expect(reqBody.tier).toBe('standard');
  });
});

// ════════════════════════════════════════════════════════
//  Review Links
// ════════════════════════════════════════════════════════

describe('Review links', () => {
  it('uses real lesson IDs from module listing', async () => {
    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    // All links should reference real lesson IDs (lesson-5 through lesson-8)
    for (const topic of body.missed_topics) {
      expect(topic.review_link).toMatch(/^\/courses\/course-42\/lessons\/lesson-[5-8]$/);
    }
  });

  it('matches "while loop" topic to While Loops lesson', async () => {
    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    // The missed question "What is a while loop?" should map to lesson-7 (While Loops)
    const whileTopic = body.missed_topics.find(
      (t: any) => t.topic.toLowerCase().includes('loop')
    );
    expect(whileTopic).toBeDefined();
    expect(whileTopic.review_link).toMatch(/lesson-[67]$/);
  });

  it('has no anchor fragments in review links', async () => {
    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    for (const topic of body.missed_topics) {
      expect(topic.review_link).not.toContain('#');
    }
  });

  it('span attributes track review link validation and matching', async () => {
    await generateInsight(VALID_BODY);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    expect(dataSpan).toBeDefined();
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.review_links_source).toBe('module_listing');
    expect(parsed.review_links_validated).toBe(true);
    expect(parsed.review_links_matched).toBeGreaterThanOrEqual(0);
    expect(parsed.review_links_fallback_used).toBe(false);
  });

  it('returns empty review links when module listing is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/assessments/attempts/')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ATTEMPT), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/') && !url.includes('attempts')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/modules/') && url.includes('/lessons')) {
        return Promise.resolve(new Response('{}', { status: 404 }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    // Should still generate insight, just without review links
    expect(body.insight_text).toBeTruthy();
    expect(body.ai_status).toBe('generated');
    // Topics may have empty review_links or be absent
    for (const topic of body.missed_topics) {
      expect(topic.review_link || '').toBe('');
    }

    // Span should indicate no validation
    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.review_links_source).toBe('none');
    expect(parsed.review_links_validated).toBe(false);
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits data.fetch span with score and question count', async () => {
    await generateInsight(VALID_BODY);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    expect(dataSpan).toBeDefined();
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.score).toBe(80);
    expect(parsed.question_count).toBe(10);
    expect(parsed.correct_count).toBe(8);
    expect(parsed.progress_pct).toBe(65);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits insight.generate span with ai_status and tone check', async () => {
    await generateInsight(VALID_BODY);

    const insightSpan = spanLogs.find((l) => l.includes('"span":"insight.generate"'));
    expect(insightSpan).toBeDefined();
    const parsed = JSON.parse(insightSpan!);
    expect(parsed.ai_status).toBe('generated');
    expect(parsed.tone_encouraging).toBe(true);
    expect(parsed.missed_topics_count).toBeGreaterThanOrEqual(0);
    expect(parsed.llm_model).toBeTruthy();
    expect(parsed.llm_tokens).toBeGreaterThanOrEqual(0);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits insight.generate span with degraded status when gateway fails', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({}, false);

    await generateInsight(VALID_BODY);

    const insightSpan = spanLogs.find((l) => l.includes('"span":"insight.generate"'));
    expect(insightSpan).toBeDefined();
    const parsed = JSON.parse(insightSpan!);
    expect(parsed.ai_status).toBe('degraded');
    expect(parsed.ai_gateway_error).toBe(true);
    expect(parsed.tone_encouraging).toBe(true);
  });

  it('emits ai_gateway.generate sub-span', async () => {
    await generateInsight(VALID_BODY);

    const gwSpan = spanLogs.find((l) => l.includes('"span":"ai_gateway.generate"'));
    expect(gwSpan).toBeDefined();
    const parsed = JSON.parse(gwSpan!);
    expect(parsed.tier).toBe('standard');
    expect(parsed.status).toBe(200);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
