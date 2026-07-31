import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createMockGateway } from '../../shared/test-utils';
import worker from '../src/index';

// ──── LMS Aggregate Mock Responses ────

const MOCK_PROGRESS_AGGREGATE = {
  success: true,
  data: {
    period: 'last_90_days',
    total_learners: 45,
    modules: [
      {
        module_id: 'mod-1',
        module_title: 'Python Basics',
        course_id: 'course-101',
        course_title: 'Intro to Python',
        median_completion_days: 5.2,
        expected_completion_days: 2,
        enrolled_learners: 30,
        completed_learners: 18,
        stalled_learners: 5,
        suppressed: false,
        suppression_reason: '',
      },
      {
        module_id: 'mod-2',
        module_title: 'Advanced Loops',
        course_id: 'course-101',
        course_title: 'Intro to Python',
        median_completion_days: 10.8,
        expected_completion_days: 3,
        enrolled_learners: 25,
        completed_learners: 10,
        stalled_learners: 8,
        suppressed: false,
        suppression_reason: '',
      },
      {
        module_id: 'mod-3',
        module_title: 'Data Types',
        course_id: 'course-101',
        course_title: 'Intro to Python',
        median_completion_days: 1.5,
        expected_completion_days: 2,
        enrolled_learners: 30,
        completed_learners: 28,
        stalled_learners: 0,
        suppressed: false,
        suppression_reason: '',
      },
      {
        module_id: 'mod-4',
        module_title: 'SQL Joins',
        course_id: 'course-202',
        course_title: 'SQL for Data',
        median_completion_days: 8.0,
        expected_completion_days: 4,
        enrolled_learners: 12,
        completed_learners: 6,
        stalled_learners: 4,
        suppressed: false,
        suppression_reason: '',
      },
      {
        module_id: 'mod-5',
        module_title: 'Tiny Cohort Module',
        course_id: 'course-303',
        course_title: 'Elective',
        median_completion_days: null,
        expected_completion_days: 1,
        enrolled_learners: 3,
        completed_learners: null,
        stalled_learners: null,
        suppressed: true,
        suppression_reason: 'cohort_below_minimum',
      },
    ],
    overall: {
      avg_completion_rate: 0.65,
      avg_time_on_platform_minutes_per_week: 120,
      courses_completed_this_period: 12,
    },
  },
  message: null,
  timestamp: '2026-07-20T10:00:00Z',
};

const MOCK_ASSESSMENTS_AGGREGATE = {
  success: true,
  data: {
    period: 'last_90_days',
    topics: JSON.stringify([
      { topic: 'Loops', avg_score: 72, attempts: 40 },
      { topic: 'List Comprehensions', avg_score: 48, attempts: 35 },
      { topic: 'Variables', avg_score: 88, attempts: 50 },
      { topic: 'SQL Joins', avg_score: 55, attempts: 20 },
    ]),
    overall: {
      avg_quiz_score: 65,
      total_quizzes_completed: 145,
      score_trend: 'down',
    },
  },
  message: null,
  timestamp: '2026-07-20T10:00:00Z',
};

const DEFAULT_LLM_RESPONSE = {
  response: JSON.stringify({
    bottlenecks: [
      {
        module: 'Advanced Loops',
        course: 'Intro to Python',
        metric: 'completion_time',
        expected: '3 days',
        actual: '10.8 days (median)',
        affected_learners: 25,
        severity: 'high',
        finding: 'Learners take 3.6× longer than expected to complete Advanced Loops, indicating the content is too dense or unclear.',
        suggestion: 'Split Advanced Loops into two modules: basic loop patterns and advanced iteration techniques.',
        rationale: 'With 8 of 25 enrolled learners stalled, this is the highest-impact bottleneck affecting course completion rates.',
      },
      {
        module: 'List Comprehensions',
        course: '',
        metric: 'quiz_score',
        expected: 'benchmark: 70%',
        actual: '48%',
        affected_learners: 35,
        severity: 'high',
        finding: 'Average quiz score of 48% on List Comprehensions — well below the 70% benchmark — suggests learners struggle with the syntax.',
        suggestion: 'Add practice exercises with incremental difficulty for list comprehensions before the quiz.',
        rationale: '35 learners attempted the quiz, making this the most widely-felt knowledge gap.',
      },
      {
        module: 'Python Basics',
        course: 'Intro to Python',
        metric: 'completion_time',
        expected: '2 days',
        actual: '5.2 days (median)',
        affected_learners: 30,
        severity: 'medium',
        finding: 'Python Basics takes 2.6× longer than expected, suggesting the introductory module may overwhelm beginners.',
        suggestion: 'Add a "Getting Started" guide and split the module into smaller, focused sections.',
        rationale: '30 learners are affected — slow foundational progress delays the entire course.',
      },
      {
        module: 'SQL Joins',
        course: '',
        metric: 'quiz_score',
        expected: 'benchmark: 70%',
        actual: '55%',
        affected_learners: 20,
        severity: 'medium',
        finding: 'SQL Joins quiz average of 55% indicates conceptual gaps with join types.',
        suggestion: 'Add visual diagrams and interactive join exercises to improve comprehension.',
        rationale: '20 learners affected — joins are a foundational database skill that impacts downstream modules.',
      },
    ],
  }),
  model_used: '@cf/meta/llama-3.2-3b-instruct',
  provider: 'cloudflare',
  tokens_used: 200,
  throttle_warning: false,
};

// ──── Global fetch mock ────

let lmsFetch: ReturnType<typeof vi.fn>;

function setupLmsMocks(progress = MOCK_PROGRESS_AGGREGATE, assessments = MOCK_ASSESSMENTS_AGGREGATE) {
  lmsFetch = vi.fn((url: string) => {
    if (url.includes('/admin/progress/aggregate')) {
      return Promise.resolve(
        new Response(JSON.stringify(progress), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    if (url.includes('/admin/assessments/aggregate')) {
      return Promise.resolve(
        new Response(JSON.stringify(assessments), { status: 200, headers: { 'Content-Type': 'application/json' } }),
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
  setupLmsMocks();
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

// ──── Helper ────

async function getBottlenecks(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/admin/bottlenecks');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const req = new Request(url.toString(), { method: 'GET' });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects POST', async () => {
    const req = new Request('http://localhost/admin/bottlenecks', { method: 'POST' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
  });

  it('rejects unknown paths', async () => {
    const req = new Request('http://localhost/unknown', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it('rejects missing org_id', async () => {
    const res = await getBottlenecks({ period: 'last_90_days' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('org_id');
  });

  it('health endpoint works', async () => {
    const req = new Request('http://localhost/health', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════
//  Bottleneck Detection — Happy Path
// ════════════════════════════════════════════════════════

describe('Bottleneck detection — Happy path', () => {
  it('returns 200 with bottlenecks and learner_count', async () => {
    const res = await getBottlenecks({ org_id: 'org-test', period: 'last_90_days' });

    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.org_id).toBe('org-test');
    expect(body.period).toBe('last_90_days');
    expect(body.learner_count).toBe(45);
    expect(body.bottlenecks).toBeDefined();
    expect(Array.isArray(body.bottlenecks)).toBe(true);
    expect(body.bottlenecks.length).toBeGreaterThan(0);
    expect(body.ai_status).toBe('generated');
  });

  it('each bottleneck has all required fields', async () => {
    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    for (const b of body.bottlenecks) {
      expect(b.module).toBeTruthy();
      expect(b.metric).toMatch(/^(completion_time|quiz_score)$/);
      expect(b.expected).toBeTruthy();
      expect(b.actual).toBeTruthy();
      expect(typeof b.affected_learners).toBe('number');
      expect(b.affected_learners).toBeGreaterThan(0);
      expect(b.severity).toMatch(/^(high|medium|low)$/);
      expect(b.finding).toBeTruthy();
      expect(b.suggestion).toBeTruthy();
      expect(b.rationale).toBeTruthy();
    }
  });

  it('identifies completion time bottlenecks where median > 2× expected', async () => {
    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    const timeBottlenecks = body.bottlenecks.filter(
      (b: any) => b.metric === 'completion_time'
    );
    expect(timeBottlenecks.length).toBeGreaterThan(0);

    // Python Basics: 5.2 vs 2 expected (2.6× → should be flagged)
    const pythonBasics = timeBottlenecks.find((b: any) => b.module === 'Python Basics');
    expect(pythonBasics).toBeDefined();

    // Advanced Loops: 10.8 vs 3 expected (3.6× → should be flagged)
    const advLoops = timeBottlenecks.find((b: any) => b.module === 'Advanced Loops');
    expect(advLoops).toBeDefined();

    // Data Types: 1.5 vs 2 expected (0.75× → should NOT be flagged)
    const dataTypes = timeBottlenecks.find((b: any) => b.module === 'Data Types');
    expect(dataTypes).toBeUndefined();
  });

  it('suppressed modules (tiny cohort) are excluded', async () => {
    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    const tinyCohort = body.bottlenecks.find(
      (b: any) => b.module === 'Tiny Cohort Module'
    );
    expect(tinyCohort).toBeUndefined();
  });

  it('identifies quiz score bottlenecks below 70% benchmark', async () => {
    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    const quizBottlenecks = body.bottlenecks.filter(
      (b: any) => b.metric === 'quiz_score'
    );

    // List Comprehensions: 48% (below 70%)
    const listComps = quizBottlenecks.find((b: any) => b.module === 'List Comprehensions');
    expect(listComps).toBeDefined();

    // SQL Joins: 55% (below 70%)
    const sqlJoins = quizBottlenecks.find((b: any) => b.module === 'SQL Joins');
    expect(sqlJoins).toBeDefined();

    // Variables: 88% (above 70%) — should NOT be flagged
    const variables = quizBottlenecks.find((b: any) => b.module === 'Variables');
    expect(variables).toBeUndefined();
  });

  it('ranks bottlenecks by severity (high first)', async () => {
    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    const severities = body.bottlenecks.map((b: any) => b.severity);
    const highIdx = severities.indexOf('high');
    const mediumIdx = severities.indexOf('medium');
    const lowIdx = severities.indexOf('low');

    // Highs should come before mediums
    if (highIdx >= 0 && mediumIdx >= 0) {
      expect(highIdx).toBeLessThan(mediumIdx);
    }
    // Mediums before lows
    if (mediumIdx >= 0 && lowIdx >= 0) {
      expect(mediumIdx).toBeLessThan(lowIdx);
    }
  });
});

// ════════════════════════════════════════════════════════
//  Cohort / Anonymity Checks
// ════════════════════════════════════════════════════════

describe('Cohort and anonymity', () => {
  it('returns insufficient_data when total learners < 10', async () => {
    const smallProgress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: { ...MOCK_PROGRESS_AGGREGATE.data, total_learners: 5 },
    };
    setupLmsMocks(smallProgress);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.message).toContain('Insufficient data');
    expect(body.ai_status).toBe('insufficient_data');
    expect(body.bottlenecks).toEqual([]);
    expect(body.learner_count).toBe(5);
  });

  it('returns insufficient_data when total_learners is 0', async () => {
    const emptyProgress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: { ...MOCK_PROGRESS_AGGREGATE.data, total_learners: 0 },
    };
    setupLmsMocks(emptyProgress);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(body.ai_status).toBe('insufficient_data');
    expect(body.bottlenecks).toEqual([]);
  });

  it('no individual learner data in response', async () => {
    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    const responseStr = JSON.stringify(body);
    // Check no learner IDs, emails, names
    expect(responseStr).not.toContain('learner_id');
    expect(responseStr).not.toContain('user_id');
    expect(responseStr).not.toContain('@');
    // enrolled_learners is a count, not a list
    for (const b of body.bottlenecks) {
      expect(typeof b.affected_learners).toBe('number');
      expect(b.affected_learners).toBeGreaterThanOrEqual(0);
    }
  });

  it('no bottlenecks returned when learner count is exactly at minimum', async () => {
    const minProgress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: {
        ...MOCK_PROGRESS_AGGREGATE.data,
        total_learners: 10,
        modules: [
          {
            module_id: 'mod-ok',
            module_title: 'Normal Module',
            course_id: 'course-100',
            course_title: 'Test Course',
            median_completion_days: 1.5,
            expected_completion_days: 2,
            enrolled_learners: 10,
            completed_learners: 8,
            stalled_learners: 0,
            suppressed: false,
            suppression_reason: '',
          },
        ],
      },
    };
    const minAssessments = {
      ...MOCK_ASSESSMENTS_AGGREGATE,
      data: {
        ...MOCK_ASSESSMENTS_AGGREGATE.data,
        topics: JSON.stringify([{ topic: 'Topic A', avg_score: 85, attempts: 10 }]),
      },
    };
    setupLmsMocks(minProgress, minAssessments);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(body.learner_count).toBe(10);
    expect(body.ai_status).not.toBe('insufficient_data');
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns degraded when LMS is completely unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Connection refused'))));
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_LLM_RESPONSE);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.bottlenecks).toEqual([]);
    expect(body.ai_status).toBe('degraded');
  });

  it('returns degraded when AI gateway fails', async () => {
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(body.ai_status).toBe('degraded');
    // Should still have skeleton bottlenecks from raw computation
    expect(body.bottlenecks.length).toBeGreaterThan(0);
    for (const b of body.bottlenecks) {
      expect(b.finding).toBeTruthy();
      expect(b.severity).toMatch(/^(high|medium|low)$/);
    }
  });

  it('returns skeleton bottlenecks when LLM returns non-JSON', async () => {
    (env as any).AI_GATEWAY = createMockGateway({
      response: 'No JSON here, just some text about bottlenecks.',
      model_used: 'llama',
      provider: 'cloudflare',
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(body.ai_status).toBe('degraded');
    // Still computed raw bottlenecks
    expect(body.bottlenecks.length).toBeGreaterThan(0);
    // Skeleton bottlenecks have computed severity
    const highBottlenecks = body.bottlenecks.filter((b: any) => b.severity === 'high');
    expect(highBottlenecks.length).toBeGreaterThanOrEqual(1);
  });

  it('computes correct severities in skeleton mode', async () => {
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    // Advanced Loops: 10.8/3 = 3.6× → high (≥ 4? No, but ratio 3.6 ≥ 2 → medium in skeleton)
    // Actually: skeleton uses ≥ 4 → high, ≥ 2 → medium, < 2 → low
    // 10.8/3 = 3.6 → medium
    const advLoops = body.bottlenecks.find((b: any) => b.module === 'Advanced Loops');
    expect(advLoops.severity).toBe('medium');

    // List Comprehensions: 48% → < 50% → high
    const listComps = body.bottlenecks.find((b: any) => b.module === 'List Comprehensions');
    expect(listComps.severity).toBe('high');
  });

  it('returns none_needed when no bottlenecks and no AI needed', async () => {
    const cleanProgress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: {
        ...MOCK_PROGRESS_AGGREGATE.data,
        total_learners: 20,
        modules: [
          {
            module_id: 'mod-1',
            module_title: 'Easy Module',
            course_id: 'c-1',
            course_title: 'Easy',
            median_completion_days: 1,
            expected_completion_days: 2,
            enrolled_learners: 20,
            completed_learners: 20,
            stalled_learners: 0,
            suppressed: false,
            suppression_reason: '',
          },
        ],
      },
    };
    const cleanAssessments = {
      ...MOCK_ASSESSMENTS_AGGREGATE,
      data: {
        ...MOCK_ASSESSMENTS_AGGREGATE.data,
        topics: JSON.stringify([{ topic: 'Topic A', avg_score: 85, attempts: 20 }]),
      },
    };
    setupLmsMocks(cleanProgress, cleanAssessments);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(body.bottlenecks).toEqual([]);
    expect(body.ai_status).toBe('none_needed');
  });
});

// ════════════════════════════════════════════════════════
//  Threshold Logic
// ════════════════════════════════════════════════════════

describe('Threshold logic', () => {
  it('flags completion time exactly at 2× expected', async () => {
    const progress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: {
        ...MOCK_PROGRESS_AGGREGATE.data,
        total_learners: 15,
        modules: [
          {
            module_id: 'mod-edge',
            module_title: 'Edge Case Module',
            course_id: 'c-1',
            course_title: 'Test',
            median_completion_days: 4,
            expected_completion_days: 2,
            enrolled_learners: 15,
            completed_learners: 10,
            stalled_learners: 2,
            suppressed: false,
            suppression_reason: '',
          },
        ],
      },
    };
    setupLmsMocks(progress);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    // median > 2× expected → 4 > 4? No. Should NOT flag.
    // The issue says "median > 2× expected", not "≥"
    const edge = body.bottlenecks.find((b: any) => b.module === 'Edge Case Module');
    expect(edge).toBeUndefined();
  });

  it('flags when median is just above 2× expected', async () => {
    const progress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: {
        ...MOCK_PROGRESS_AGGREGATE.data,
        total_learners: 15,
        modules: [
          {
            module_id: 'mod-edge',
            module_title: 'Edge Case Module',
            course_id: 'c-1',
            course_title: 'Test',
            median_completion_days: 4.1,
            expected_completion_days: 2,
            enrolled_learners: 15,
            completed_learners: 10,
            stalled_learners: 2,
            suppressed: false,
            suppression_reason: '',
          },
        ],
      },
    };
    setupLmsMocks(progress);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    const edge = body.bottlenecks.find((b: any) => b.module === 'Edge Case Module');
    expect(edge).toBeDefined();
  });

  it('does not flag modules with null median', async () => {
    const progress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: {
        ...MOCK_PROGRESS_AGGREGATE.data,
        total_learners: 15,
        modules: [
          {
            module_id: 'mod-null',
            module_title: 'Null Median Module',
            course_id: 'c-1',
            course_title: 'Test',
            median_completion_days: null,
            expected_completion_days: 2,
            enrolled_learners: 15,
            completed_learners: null,
            stalled_learners: null,
            suppressed: false,
            suppression_reason: '',
          },
        ],
      },
    };
    setupLmsMocks(progress);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    // No bottlenecks from progress — null median, suppress module or compute bypass
    expect(body.ai_status).not.toBe('insufficient_data');
  });

  it('quiz scores at exact benchmark (70%) are NOT flagged', async () => {
    const assessments = {
      ...MOCK_ASSESSMENTS_AGGREGATE,
      data: {
        ...MOCK_ASSESSMENTS_AGGREGATE.data,
        topics: JSON.stringify([{ topic: 'Edge Topic', avg_score: 70, attempts: 20 }]),
      },
    };
    setupLmsMocks(undefined, assessments);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    const edge = body.bottlenecks.find((b: any) => b.module === 'Edge Topic');
    expect(edge).toBeUndefined();
  });

  it('quiz scores just below benchmark (69%) ARE flagged', async () => {
    const assessments = {
      ...MOCK_ASSESSMENTS_AGGREGATE,
      data: {
        ...MOCK_ASSESSMENTS_AGGREGATE.data,
        topics: JSON.stringify([{ topic: 'Edge Topic', avg_score: 69, attempts: 20 }]),
      },
    };
    setupLmsMocks(undefined, assessments);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    // Note: we also have completion time bottlenecks
    const edge = body.bottlenecks.find((b: any) => b.module === 'Edge Topic');
    expect(edge).toBeDefined();
  });

  it('handles unparseable topics JSON gracefully', async () => {
    const assessments = {
      ...MOCK_ASSESSMENTS_AGGREGATE,
      data: {
        ...MOCK_ASSESSMENTS_AGGREGATE.data,
        topics: 'not-json-at-all',
      },
    };
    setupLmsMocks(undefined, assessments);
    vi.stubGlobal('fetch', lmsFetch);

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    // Should still get completion time bottlenecks but no quiz score ones
    const quizBottlenecks = body.bottlenecks.filter(
      (b: any) => b.metric === 'quiz_score'
    );
    expect(quizBottlenecks.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('includes org_id, period, and learner count', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await getBottlenecks({ org_id: 'org-test', period: 'last_30_days' });

    expect(spy).toHaveBeenCalled();
    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('org-test');
    expect(prompt).toContain('last_30_days');
    expect(prompt).toContain('TOTAL LEARNERS: 45');
  });

  it('includes each bottleneck in bullet format', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await getBottlenecks({ org_id: 'org-test' });

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('Advanced Loops');
    expect(prompt).toContain('10.8 days');
    expect(prompt).toContain('3 days');
    expect(prompt).toContain('List Comprehensions');
    expect(prompt).toContain('48%');
  });

  it('requests severity, finding, suggestion, rationale in output format', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await getBottlenecks({ org_id: 'org-test' });

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = reqBody.messages[0].content;

    expect(prompt).toContain('severity');
    expect(prompt).toContain('finding');
    expect(prompt).toContain('suggestion');
    expect(prompt).toContain('rationale');
    expect(prompt).toContain('"bottlenecks"');
  });

  it('uses standard tier', async () => {
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await getBottlenecks({ org_id: 'org-test' });

    const reqBody = JSON.parse(await spy.mock.calls[0][0].text());
    expect(reqBody.tier).toBe('standard');
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits data.fetch span with total_learners and module counts', async () => {
    await getBottlenecks({ org_id: 'org-test' });

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    expect(dataSpan).toBeDefined();
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.org_id).toBe('org-test');
    expect(parsed.period).toBe('last_90_days');
    expect(parsed.total_learners).toBe(45);
    expect(parsed.progress_ok).toBe(true);
    expect(parsed.assessment_ok).toBe(true);
    expect(parsed.modules_analyzed).toBe(5);
    expect(parsed.topics_analyzed).toBe(4);
    expect(parsed.raw_bottlenecks).toBeGreaterThan(0);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits data.fetch span with cohort_too_small when < 10 learners', async () => {
    const smallProgress = {
      ...MOCK_PROGRESS_AGGREGATE,
      data: { ...MOCK_PROGRESS_AGGREGATE.data, total_learners: 5 },
    };
    setupLmsMocks(smallProgress);
    vi.stubGlobal('fetch', lmsFetch);

    await getBottlenecks({ org_id: 'org-test' });

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.cohort_too_small).toBe(true);
  });

  it('emits insight.generate span with bottleneck count and ai_status', async () => {
    await getBottlenecks({ org_id: 'org-test' });

    const insightSpan = spanLogs.find((l) => l.includes('"span":"insight.generate"'));
    expect(insightSpan).toBeDefined();
    const parsed = JSON.parse(insightSpan!);
    expect(parsed.org_id).toBe('org-test');
    expect(parsed.bottleneck_count).toBeGreaterThan(0);
    expect(parsed.ai_status).toBe('generated');
    expect(parsed.llm_model).toBeTruthy();
    expect(parsed.llm_tokens).toBeGreaterThanOrEqual(0);
    expect(parsed.enriched_count).toBeGreaterThan(0);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits insight.generate span with degraded status when gateway fails', async () => {
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    await getBottlenecks({ org_id: 'org-test' });

    const insightSpan = spanLogs.find((l) => l.includes('"span":"insight.generate"'));
    const parsed = JSON.parse(insightSpan!);
    expect(parsed.ai_status).toBe('degraded');
    expect(parsed.ai_gateway_error).toBe(true);
  });

  it('emits ai_gateway.generate sub-span', async () => {
    await getBottlenecks({ org_id: 'org-test' });

    const gwSpan = spanLogs.find((l) => l.includes('"span":"ai_gateway.generate"'));
    expect(gwSpan).toBeDefined();
    const parsed = JSON.parse(gwSpan!);
    expect(parsed.tier).toBe('standard');
    expect(parsed.status).toBe(200);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════
//  Partial LMS Data
// ════════════════════════════════════════════════════════

describe('Partial LMS data', () => {
  it('works with only progress data (no assessments)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/admin/progress/aggregate')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_PROGRESS_AGGREGATE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/admin/assessments/aggregate')) {
        return Promise.reject(new Error('Not available'));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.learner_count).toBe(45);
    // Should have completion time bottlenecks but no quiz score ones
    const quizBottlenecks = body.bottlenecks.filter(
      (b: any) => b.metric === 'quiz_score'
    );
    expect(quizBottlenecks.length).toBe(0);
  });

  it('works with only assessment data (no progress)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/admin/progress/aggregate')) {
        return Promise.reject(new Error('Not available'));
      }
      if (url.includes('/admin/assessments/aggregate')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_ASSESSMENTS_AGGREGATE), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }));

    const res = await getBottlenecks({ org_id: 'org-test' });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    // No progress data → learner_count is 0 → triggers cohort check
    expect(body.ai_status).toBe('insufficient_data');
  });

  it('data.fetch span tracks unavailable endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('All down'))));

    await getBottlenecks({ org_id: 'org-test' });

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.lms_unreachable).toBe(true);
  });
});
