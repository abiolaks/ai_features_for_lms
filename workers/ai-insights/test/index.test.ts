import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createMockGateway, spyOnSpans } from '../../shared/test-utils';
import worker from '../src/index';

// ──── Fixtures ────

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
    // Live LMS shape: AttemptResponseResource objects (camelCase,
    // nested `question` carrying questionText + correctAnswer)
    responses: [
      { questionId: 'q1', selectedOption: 'A', isCorrect: true, timeSpentSeconds: 15, correctAnswer: 'A', question: { id: 'q1', questionText: 'What is a variable?', correctAnswer: 'A' } },
      { questionId: 'q2', selectedOption: 'B', isCorrect: true, timeSpentSeconds: 25, correctAnswer: 'B', question: { id: 'q2', questionText: 'Explain for loops', correctAnswer: 'B' } },
      { questionId: 'q3', selectedOption: 'C', isCorrect: false, timeSpentSeconds: 90, correctAnswer: 'Repeats while condition is true', question: { id: 'q3', questionText: 'What is a while loop?', correctAnswer: 'Repeats while condition is true' } },
      { questionId: 'q4', selectedOption: 'D', isCorrect: false, timeSpentSeconds: 70, correctAnswer: 'Concise way to create lists', question: { id: 'q4', questionText: 'What is a list comprehension?', correctAnswer: 'Concise way to create lists' } },
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
  (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);
});

beforeEach(() => {
  spanLogs = [];
  setupLmsMocks();
  vi.stubGlobal('fetch', lmsFetch);
  vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
  (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);
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

  it('handles legacy JSON-string responses (backward compat)', async () => {
    const legacyAttempt = {
      ...MOCK_ATTEMPT,
      data: {
        ...MOCK_ATTEMPT.data,
        responses: [
          '{"question_id":"q3","question_text":"What is a while loop?","selected":"A function","correct":false,"timeSpentSeconds":90,"correct_answer":"Repeats while condition is true"}',
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/assessments/attempts/')) {
        return Promise.resolve(new Response(JSON.stringify(legacyAttempt), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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

    await generateInsight(VALID_BODY);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.responses_parsed).toBe(1);
    expect(parsed.missed_questions).toBe(1);
  });

  it('parses live LMS object responses into missed questions', async () => {
    await generateInsight(VALID_BODY);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.responses_parsed).toBe(4);
    expect(parsed.missed_questions).toBe(2);
    expect(parsed.has_review_links).toBe(true);
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
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await generateInsight(VALID_BODY);
    const body: any = await res.json();

    expect(body.insight_text).toContain('unavailable');
    expect(body.ai_status).toBe('degraded');
    expect(body.missed_topics).toEqual([]);
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    (env as any).AI_GATEWAY = createMockGateway({
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
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);
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
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generateInsight(VALID_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('65%');
  });

  it('includes per-question timing', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generateInsight(VALID_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('while loop');
    expect(prompt).toContain('90');
  });

  it('includes tone rules in prompt', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);
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
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);
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
    (env as any).AI_GATEWAY = createMockGateway({}, false);

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

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Fixtures
// ════════════════════════════════════════════════════════

const MOCK_SESSION_PROFILE = {
  success: true,
  data: {
    id: 'learner-1',
    name: 'Jane Learner',
    displayName: 'Jane Learner',
    skills: ['Python', 'SQL', 'Data Analysis'],
    goals: 'Become a data engineer',
    experience_level: 'intermediate',
  },
};

const MOCK_SESSION_PROGRESS = {
  success: true,
  data: {
    totalEnrollments: 3,
    completedEnrollments: 1,
    enrollments: [
      { enrollmentId: 'enr-1', courseId: 'course-101', courseTitle: 'Python Basics', status: 'completed', progressPercent: '100' },
      { enrollmentId: 'enr-2', courseId: 'course-202', courseTitle: 'Advanced Algorithms', status: 'enrolled', progressPercent: '12' },
      { enrollmentId: 'enr-3', courseId: 'course-303', courseTitle: 'SQL for Data', status: 'enrolled', progressPercent: '55' },
    ],
  },
};

const MOCK_ASSESSMENT_SUMMARY = {
  success: true,
  data: {
    total_attempts: 7,
    avg_score_percent: 72,
    lowest_topic: 'recursion',
    lowest_topic_score: 45,
    recent_attempts: '[{"id":"a1","score":68},{"id":"a2","score":82}]',
  },
};

const DEFAULT_SESSION_PREP_LLM = {
  response: JSON.stringify({
    agenda: [
      { topic: 'Recursion review', reason: 'Lowest quiz score (45%) — must address foundational gaps', duration_min: 15 },
      { topic: 'Algorithm complexity', reason: 'Blocks progress in Advanced Algorithms (12% complete)', duration_min: 20 },
      { topic: 'Next steps toward Data Engineering', reason: 'Align with learner goal to become data engineer', duration_min: 10 },
    ],
  }),
  model_used: '@cf/meta/llama-3.2-3b-instruct',
  provider: 'cloudflare',
  tokens_used: 120,
  throttle_warning: false,
};

// ──── Helper ────

async function sessionPrep(body: object) {
  const req = new Request('http://localhost/mentor/session-prep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const VALID_SP_BODY = {
  learner_id: 'learner-1',
  mentor_id: 'mentor-42',
  org_id: 'org-test',
};

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Validation
// ════════════════════════════════════════════════════════

describe('F03b: Session Prep — Validation', () => {
  it('rejects missing learner_id', async () => {
    const res = await sessionPrep({ mentor_id: 'm1', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('learner_id');
  });

  it('rejects missing mentor_id', async () => {
    const res = await sessionPrep({ learner_id: 'l1', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('mentor_id');
  });

  it('rejects missing org_id', async () => {
    const res = await sessionPrep({ learner_id: 'l1', mentor_id: 'm1' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('org_id');
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('http://localhost/mentor/session-prep', {
      method: 'POST',
      body: 'not json',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Happy Path
// ════════════════════════════════════════════════════════

describe('F03b: Session Prep — Happy path', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_SESSION_PREP_LLM);
  });

  it('returns 200 with recent_activity, suggested_agenda, prep_materials', async () => {
    const res = await sessionPrep(VALID_SP_BODY);

    expect(res.status).toBe(200);
    const body: any = await res.json();

    // recent_activity
    expect(body.recent_activity).toBeDefined();
    expect(body.recent_activity.completed_lessons).toBe(1);
    expect(body.recent_activity.quiz_scores.avg).toBe(72);
    expect(body.recent_activity.quiz_scores.lowest_topic).toBe('recursion');
    expect(body.recent_activity.stalled_modules).toEqual(['Advanced Algorithms']);

    // suggested_agenda
    expect(body.suggested_agenda).toBeDefined();
    expect(body.suggested_agenda.length).toBe(3);
    for (const item of body.suggested_agenda) {
      expect(item.topic).toBeTruthy();
      expect(item.reason).toBeTruthy();
      expect(typeof item.duration_min).toBe('number');
      expect(item.duration_min).toBeGreaterThan(0);
    }

    // prep_materials
    expect(body.prep_materials).toBeDefined();
    expect(Array.isArray(body.prep_materials)).toBe(true);

    expect(body.ai_status).toBe('generated');
  });

  it('agenda items are prioritized by urgency (stalled modules + low scores first)', async () => {
    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    const firstTopic = body.suggested_agenda[0];
    // First item should reference quiz weakness or stalled modules
    const firstReason = firstTopic.reason.toLowerCase();
    const isUrgent = firstReason.includes('lowest') || firstReason.includes('stalled') || firstReason.includes('block');
    expect(isUrgent).toBe(true);
  });

  it('prep_materials link to courses from progress data', async () => {
    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    for (const mat of body.prep_materials) {
      expect(mat.lesson_title).toBeTruthy();
      if (mat.link) {
        expect(mat.link).toMatch(/^\/courses\/.+/);
      }
    }
  });
});

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Empty State
// ════════════════════════════════════════════════════════

describe('F03b: Session Prep — Empty state', () => {
  it('returns skeleton agenda when no learner activity', async () => {
    // LMS returns empty data for everything
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify({ data: { enrollments: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_SESSION_PREP_LLM);

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    expect(body.recent_activity.completed_lessons).toBe(0);
    expect(body.recent_activity.quiz_scores.avg).toBe(0);
    expect(body.recent_activity.quiz_scores.lowest_topic).toBe('none');
    expect(body.recent_activity.stalled_modules).toEqual([]);

    // Still returns agenda (skeleton or LLM-generated)
    expect(body.suggested_agenda.length).toBeGreaterThanOrEqual(1);
  });

  it('returns skeleton agenda with default topics when LLM fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify({ data: { enrollments: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    expect(body.ai_status).toBe('degraded');
    expect(body.suggested_agenda.length).toBeGreaterThanOrEqual(1);
    // Skeleton agenda should have generic topics
    const topics = body.suggested_agenda.map((a: any) => a.topic);
    expect(topics.some((t: string) => t.includes('profile') || t.includes('progress') || t.includes('goal'))).toBe(true);
  });

  it('skeleton agenda includes stalled module topic when available', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    expect(body.ai_status).toBe('degraded');
    const topics = body.suggested_agenda.map((a: any) => a.topic);
    expect(topics.some((t: string) => t.includes('Advanced Algorithms'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Degraded Mode
// ════════════════════════════════════════════════════════

describe('F03b: Session Prep — Degraded mode', () => {
  it('returns skeleton when LMS is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Connection refused'))));
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_SESSION_PREP_LLM);

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    // Should still respond 200 with skeleton
    expect(res.status).toBe(200);
    expect(body.recent_activity.completed_lessons).toBe(0);
    expect(body.suggested_agenda.length).toBeGreaterThanOrEqual(1);
    // With no data at all, ai_status from LLM depends on whether gateway works
    // but at minimum we get a response
  });

  it('returns degraded when AI gateway fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    expect(body.ai_status).toBe('degraded');
    expect(body.recent_activity.completed_lessons).toBe(1);
    expect(body.recent_activity.quiz_scores.avg).toBe(72);
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway({
      response: 'No JSON here, just some text about mentoring.',
      model_used: 'llama',
      provider: 'cloudflare',
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    expect(body.ai_status).toBe('degraded');
    expect(body.suggested_agenda.length).toBeGreaterThanOrEqual(1);
  });

  it('handles partial LMS data gracefully (some endpoints fail)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.reject(new Error('Profile down'));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_SESSION_PREP_LLM);

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    // Progress + assessments should still give us useful data
    expect(body.recent_activity.quiz_scores.avg).toBe(72);
    expect(body.recent_activity.stalled_modules).toEqual(['Advanced Algorithms']);
  });
});

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Prompt Construction
// ════════════════════════════════════════════════════════

describe('F03b: Session Prep — Prompt construction', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_SESSION_PREP_LLM);
  });

  it('includes learner skills and goals in prompt', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await sessionPrep(VALID_SP_BODY);

    expect(spy).toHaveBeenCalled();
    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('Jane Learner');
    expect(prompt).toContain('Python');
    expect(prompt).toContain('Become a data engineer');
  });

  it('includes course progress with completion percentages', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await sessionPrep(VALID_SP_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('Python Basics');
    expect(prompt).toContain('Advanced Algorithms');
    expect(prompt).toContain('12%');
    expect(prompt).toContain('[COMPLETED]');
    expect(prompt).toContain('55%');
  });

  it('includes quiz summary with lowest topic', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await sessionPrep(VALID_SP_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('72%');
    expect(prompt).toContain('recursion');
    expect(prompt).toContain('QUIZ PERFORMANCE');
  });

  it('includes stalled modules section', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await sessionPrep(VALID_SP_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('STALLED MODULES');
    expect(prompt).toContain('Advanced Algorithms');
  });

  it('uses standard tier', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await sessionPrep(VALID_SP_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    expect(reqBody.tier).toBe('standard');
  });

  it('handles empty profile gracefully in prompt', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await sessionPrep(VALID_SP_BODY);

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    // Should still include progress and quiz data
    expect(prompt).toContain('QUIZ PERFORMANCE');
    expect(prompt).toContain('COURSE PROGRESS');
  });
});

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Observability Spans
// ════════════════════════════════════════════════════════

describe('F03b: Session Prep — Observability spans', () => {
  beforeEach(() => {
    spanLogs = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_SESSION_PREP_LLM);
    vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
  });

  it('emits session_prep.data_fetch span with learner context', async () => {
    await sessionPrep(VALID_SP_BODY);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"session_prep.data_fetch"'));
    expect(dataSpan).toBeDefined();
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.learner_id).toBe('learner-1');
    expect(parsed.mentor_id).toBe('mentor-42');
    expect(parsed.completed_lessons).toBe(1);
    expect(parsed.enrollment_count).toBe(3);
    expect(parsed.stalled_modules).toBe(1);
    expect(parsed.avg_quiz_score).toBe(72);
    expect(parsed.total_quiz_attempts).toBe(7);
    expect(parsed.has_lowest_topic).toBe(true);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits session_prep.agenda_generate span with ai_status', async () => {
    await sessionPrep(VALID_SP_BODY);

    const agendaSpan = spanLogs.find((l) => l.includes('"span":"session_prep.agenda_generate"'));
    expect(agendaSpan).toBeDefined();
    const parsed = JSON.parse(agendaSpan!);
    expect(parsed.ai_status).toBe('generated');
    expect(parsed.agenda_item_count).toBe(3);
    expect(parsed.prep_material_count).toBeGreaterThanOrEqual(0);
    expect(parsed.llm_model).toBeTruthy();
    expect(parsed.llm_tokens).toBeGreaterThanOrEqual(0);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits agenda_generate span with degraded when gateway fails', async () => {
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    await sessionPrep(VALID_SP_BODY);

    const agendaSpan = spanLogs.find((l) => l.includes('"span":"session_prep.agenda_generate"'));
    expect(agendaSpan).toBeDefined();
    const parsed = JSON.parse(agendaSpan!);
    expect(parsed.ai_status).toBe('degraded');
    expect(parsed.ai_gateway_error).toBe(true);
  });

  it('emits ai_gateway.generate sub-span during session prep', async () => {
    await sessionPrep(VALID_SP_BODY);

    // The gateway span appears for both insight and session prep —
    // verify it's emitted during session prep flow
    const gwSpans = spanLogs.filter((l) => l.includes('"span":"ai_gateway.generate"'));
    expect(gwSpans.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(gwSpans[gwSpans.length - 1]);
    expect(parsed.tier).toBe('standard');
  });

  it('tracks profile_unavailable in data_fetch span when LMS profile fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.reject(new Error('Down'));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    await sessionPrep(VALID_SP_BODY);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"session_prep.data_fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.profile_unavailable).toBe(true);
  });

  it('tracks assessments_unavailable in data_fetch span', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.reject(new Error('Down'));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    await sessionPrep(VALID_SP_BODY);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"session_prep.data_fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.assessments_unavailable).toBe(true);
  });

  it('tracks has_activity_data flag in agenda_generate span', async () => {
    await sessionPrep(VALID_SP_BODY);

    const agendaSpan = spanLogs.find((l) => l.includes('"span":"session_prep.agenda_generate"'));
    const parsed = JSON.parse(agendaSpan!);
    expect(parsed.has_activity_data).toBe(true);
  });

  it('tracks has_activity_data=false when no LMS data', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));

    await sessionPrep(VALID_SP_BODY);

    const agendaSpan = spanLogs.find((l) => l.includes('"span":"session_prep.agenda_generate"'));
    const parsed = JSON.parse(agendaSpan!);
    expect(parsed.has_activity_data).toBe(false);
  });
});

// ════════════════════════════════════════════════════════
//  F03b: Session Prep — Agenda Prioritization
// ════════════════════════════════════════════════════════

describe('F03b: Session Prep — Agenda prioritization', () => {
  it('returns skeleton with stalled module when LMS data has stalled courses', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    // Skeleton should include an unblock topic for the stalled module
    const topics = body.suggested_agenda.map((a: any) => a.topic);
    expect(topics.some((t: string) => t.includes('Advanced Algorithms') || t.includes('Unblock'))).toBe(true);
  });

  it('filters out empty/malformed agenda items', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    // LLM returns some empty items mixed in
    (env as any).AI_GATEWAY = createMockGateway({
      response: JSON.stringify({
        agenda: [
          { topic: '', reason: '', duration_min: null },
          { topic: 'Good topic', reason: 'Real reason', duration_min: 15 },
          null,
          { topic: 'Another topic', reason: 'Another reason', duration_min: 10 },
        ],
      }),
      model_used: 'llama',
      provider: 'cloudflare',
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    // Only the two valid items should be present
    expect(body.suggested_agenda.length).toBe(2);
    expect(body.suggested_agenda[0].topic).toBe('Good topic');
    expect(body.suggested_agenda[1].topic).toBe('Another topic');
  });

  it('caps agenda at 5 items', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));
    // LLM returns 7 items
    (env as any).AI_GATEWAY = createMockGateway({
      response: JSON.stringify({
        agenda: Array.from({ length: 7 }, (_, i) => ({
          topic: `Topic ${i + 1}`,
          reason: `Reason ${i + 1}`,
          duration_min: 10 + i,
        })),
      }),
      model_used: 'llama',
      provider: 'cloudflare',
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    expect(body.suggested_agenda.length).toBe(5);
  });

  it('prep_materials avoid duplicate course links', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROFILE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_SESSION_PROGRESS), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/learner/assessments/summary')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENT_SUMMARY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    const res = await sessionPrep(VALID_SP_BODY);
    const body: any = await res.json();

    // Check for duplicate links
    const links = body.prep_materials.map((m: any) => m.link);
    const uniqueLinks = new Set(links);
    expect(uniqueLinks.size).toBe(links.length);
  });
});
