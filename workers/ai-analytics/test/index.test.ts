// ============================================================
// F05: Admin Analytics Narratives — Test Suite
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

const MOCK_PROGRESS = {
  period: 'last_30_days',
  total_learners: 45,
  modules: [
    {
      module_id: 'mod-1',
      module_title: 'Python Functions',
      course_id: 'course-1',
      course_title: 'Python Basics',
      median_completion_days: 7,
      expected_completion_days: 5,
      enrolled_learners: 30,
      completed_learners: 18,
      stalled_learners: 12,
    },
    {
      module_id: 'mod-2',
      module_title: 'Data Structures',
      course_id: 'course-1',
      course_title: 'Python Basics',
      median_completion_days: 4,
      expected_completion_days: 5,
      enrolled_learners: 25,
      completed_learners: 22,
      stalled_learners: 3,
    },
  ],
  overall: {
    avg_completion_rate: 0.62,
    avg_time_on_platform_minutes_per_week: 45,
    courses_completed_this_period: 8,
  },
};

const MOCK_ASSESSMENTS = {
  period: 'last_30_days',
  topics: JSON.stringify([
    { topic: 'Functions', avg_score: 74, attempts: 45, benchmark: 70 },
    { topic: 'Data Structures', avg_score: 82, attempts: 38, benchmark: 70 },
    { topic: 'Loops', avg_score: 58, attempts: 30, benchmark: 70 },
  ]),
  overall: {
    avg_quiz_score: 73,
    total_quizzes_completed: 113,
    score_trend: 'up' as const,
  },
};

const MOCK_ENGAGEMENT = {
  period: 'last_30_days',
  total_active_learners: 42,
  course_engagement: [
    {
      course_id: 'course-1',
      course_title: 'Python Basics',
      enrolled_learners: 30,
      completion_rate: 0.60,
      avg_time_per_week_minutes: 45,
      stall_rate: 0.28,
    },
    {
      course_id: 'course-2',
      course_title: 'Advanced ML',
      enrolled_learners: 15,
      completion_rate: 0.72,
      avg_time_per_week_minutes: 60,
      stall_rate: 0.08,
    },
  ],
  video_engagement: [
    {
      video_id: 'vid-1',
      video_title: 'Intro to Variables',
      course_title: 'Python Basics',
      views: 120,
      avg_watch_percent: 55,
      drop_off_at_seconds: 900,
      completion_rate: 0.38,
    },
  ],
  activity_patterns: {
    by_hour: { '9': 45, '10': 60, '14': 55 },
    by_day_of_week: { monday: 120, tuesday: 110 },
    peak_hour: 10,
    peak_day: 'monday',
    off_peak_hours: [0, 1, 2, 3, 22, 23],
  },
  overall: {
    avg_completion_rate: 0.48,
    avg_time_per_week_minutes: 52,
    total_videos_watched: 450,
  },
};

const MOCK_PREV_PROGRESS = {
  period: 'previous_30_days',
  total_learners: 38,
  modules: [
    {
      module_id: 'mod-1',
      module_title: 'Python Functions',
      course_id: 'course-1',
      course_title: 'Python Basics',
      median_completion_days: 8,
      expected_completion_days: 5,
      enrolled_learners: 28,
      completed_learners: 12,
      stalled_learners: 16,
    },
  ],
  overall: {
    avg_completion_rate: 0.55,
    avg_time_on_platform_minutes_per_week: 40,
    courses_completed_this_period: 5,
  },
};

const MOCK_PREV_ASSESSMENTS = {
  period: 'previous_30_days',
  topics: JSON.stringify([
    { topic: 'Functions', avg_score: 67, attempts: 38, benchmark: 70 },
    { topic: 'Data Structures', avg_score: 78, attempts: 30, benchmark: 70 },
    { topic: 'Loops', avg_score: 62, attempts: 25, benchmark: 70 },
  ]),
  overall: {
    avg_quiz_score: 69,
    total_quizzes_completed: 93,
    score_trend: 'flat' as const,
  },
};

const MOCK_LLM_NARRATIVE = {
  summary: 'Your org had a strong month. Active learners grew from 38 to 45, and course completion rate improved 7 percentage points. Quiz scores on Functions jumped from 67% to 74% — the supplementary exercises are working. However, Python Basics still has a 28% stall rate, suggesting some learners are getting stuck. Consider adding checkpoint quizzes to re-engage them.',
  highlights: [
    {
      sentiment: 'positive',
      finding: 'Quiz scores on "Functions" improved 7 percentage points',
      evidence: '67% → 74% across 45 learners',
      likely_cause: 'Supplementary exercise set added this month',
    },
    {
      sentiment: 'positive',
      finding: 'Course completion rate up 7 percentage points',
      evidence: '55% → 62% across 45 learners',
      likely_cause: 'Improved onboarding and clearer prerequisites',
    },
    {
      sentiment: 'warning',
      finding: 'Python Basics has elevated stall rate (28%)',
      evidence: '30 enrolled, 60% completion rate',
      likely_cause: 'Module content length may be a factor',
    },
  ],
};

// ── Helper ──

function mockEnv(overrides: {
  progress?: any;
  assessments?: any;
  engagement?: any;
  prevProgress?: any;
  prevAssessments?: any;
  progressStatus?: number;
  assessmentStatus?: number;
  engagementStatus?: number;
  prevProgressStatus?: number;
  prevAssessmentStatus?: number;
  lmsError?: boolean;
  gatewayResponse?: object | null;
  gatewayOk?: boolean;
} = {}) {
  const {
    progress = MOCK_PROGRESS,
    assessments = MOCK_ASSESSMENTS,
    engagement = MOCK_ENGAGEMENT,
    prevProgress = MOCK_PREV_PROGRESS,
    prevAssessments = MOCK_PREV_ASSESSMENTS,
    progressStatus = 200,
    assessmentStatus = 200,
    engagementStatus = 200,
    prevProgressStatus = 200,
    prevAssessmentStatus = 200,
    lmsError = false,
    gatewayResponse = MOCK_LLM_NARRATIVE,
    gatewayOk = true,
  } = overrides;

  const lmsFetch = lmsError
    ? vi.fn(() => Promise.reject(new Error('Connection refused')))
    : vi.fn((input: any) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';

        if (url.includes('/admin/progress/aggregate') && url.includes('previous_')) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: prevProgress }), {
              status: prevProgressStatus,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        if (url.includes('/admin/assessments/aggregate') && url.includes('previous_')) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: prevAssessments }), {
              status: prevAssessmentStatus,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        if (url.includes('/admin/progress/aggregate')) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: progress }), {
              status: progressStatus,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        if (url.includes('/admin/assessments/aggregate')) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: assessments }), {
              status: assessmentStatus,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        if (url.includes('/admin/engagement')) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: engagement }), {
              status: engagementStatus,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

  vi.stubGlobal('fetch', lmsFetch);

  const gateway = createMockGateway(
    gatewayResponse === null
      ? {}
      : createLlmResponse(gatewayResponse),
    gatewayOk,
  );

  return { ...env, AI_GATEWAY: gateway };
}

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects non-GET methods', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative', { method: 'POST' }),
      e, ctx,
    );
    expect(resp.status).toBe(405);
    const body = (await resp.json()) as any;
    expect(body.error).toBe('method_not_allowed');
  });

  it('rejects missing org_id', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative'),
      e, ctx,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain('org_id');
  });

  it('health endpoint works', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/health'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.worker).toBe('ai-analytics');
  });
});

// ════════════════════════════════════════════════════════
//  Happy Path
// ════════════════════════════════════════════════════════

describe('Happy path', () => {
  it('returns 200 with summary, highlights, and metrics', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test&period=last_30_days'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.org_id).toBe('org-test');
    expect(body.summary).toBeTruthy();
    expect(body.summary.length).toBeGreaterThan(20);
    expect(body.highlights).toBeInstanceOf(Array);
    expect(body.highlights.length).toBeGreaterThan(0);
    expect(body.metrics).toBeDefined();
    expect(body.metrics.active_learners).toBeGreaterThan(0);
    expect(body.ai_status).toBe('generated');
    expect(body.generated_at).toBeTruthy();
  });

  it('each highlight has all required fields', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    for (const h of body.highlights) {
      expect(['positive', 'warning', 'neutral']).toContain(h.sentiment);
      expect(typeof h.finding).toBe('string');
      expect(h.finding.length).toBeGreaterThan(0);
      expect(typeof h.evidence).toBe('string');
      expect(h.evidence.length).toBeGreaterThan(0);
      // likely_cause can be null or string
      expect(h.likely_cause === null || typeof h.likely_cause === 'string').toBe(true);
    }
  });

  it('metrics includes all expected fields', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    const m = body.metrics;
    expect(m.active_learners).toBe(45);
    expect(m.avg_progress_pct).toBe(62);
    expect(m.courses_completed).toBe(8);
    expect(m.avg_quiz_score).toBe(73);
    expect(['up', 'down', 'flat', 'unavailable']).toContain(m.engagement_trend);
    expect(m.period_comparison).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
//  Period Comparison
// ════════════════════════════════════════════════════════

describe('Period comparison', () => {
  it('detects engagement trend from learner count diff', async () => {
    const e = mockEnv(); // 45 current, 38 prev → diff = +7 → up
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.metrics.engagement_trend).toBe('up');
    expect(body.metrics.period_comparison).toBe(true);
  });

  it('detects flat engagement when counts are similar', async () => {
    const e = mockEnv({
      prevProgress: { ...MOCK_PREV_PROGRESS, total_learners: 44 },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.metrics.engagement_trend).toBe('flat');
  });

  it('detects down trend when learner count drops', async () => {
    const e = mockEnv({
      prevProgress: { ...MOCK_PREV_PROGRESS, total_learners: 55 },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.metrics.engagement_trend).toBe('down');
  });

  it('includes comparison highlights for significant quiz changes', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    // Functions: 67 → 74 (+7) should trigger a highlight
    const quizHighlights = body.highlights.filter(
      (h: any) => h.finding.includes('Functions'),
    );
    expect(quizHighlights.length).toBeGreaterThan(0);
  });

  it('handles missing previous period gracefully', async () => {
    const e = mockEnv({
      prevProgressStatus: 500,
      prevAssessmentStatus: 500,
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.metrics.period_comparison).toBe(false);
    expect(body.metrics.engagement_trend).toBe('unavailable');
  });
});

// ════════════════════════════════════════════════════════
//  Cohort & Anonymity
// ════════════════════════════════════════════════════════

describe('Cohort and anonymity', () => {
  it('returns insufficient_data when < 10 learners', async () => {
    const e = mockEnv({
      progress: { ...MOCK_PROGRESS, total_learners: 5 },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('insufficient_data');
    expect(body.summary).toContain('Not enough data');
    expect(body.summary).toContain('5');
    expect(body.highlights).toEqual([]);
  });

  it('uses singular for 1 learner', async () => {
    const e = mockEnv({
      progress: { ...MOCK_PROGRESS, total_learners: 1 },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.summary).toContain('1 active learner');
  });

  it('no individual learner data in response', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/\buser[-_]\d+\b/);
    expect(text).not.toMatch(/\blearner[-_]id\b/i);
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns degraded when all LMS endpoints fail', async () => {
    const e = mockEnv({ lmsError: true });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.summary).toContain('Unable to generate');
  });

  it('returns degraded when gateway fails but still returns skeleton', async () => {
    const e = mockEnv({ gatewayOk: false });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.summary).toBeTruthy();
    expect(body.highlights.length).toBeGreaterThan(0);
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    const e = mockEnv({ gatewayResponse: 'Here is a nice summary...' });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.summary).toBeTruthy();
  });

  it('works with partial data (progress only)', async () => {
    const e = mockEnv({
      assessments: null,
      engagement: null,
      assessmentStatus: 500,
      engagementStatus: 500,
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.metrics.active_learners).toBe(45);
    expect(body.metrics.avg_quiz_score).toBe(0);
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
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const gwSpans = spans('ai_gateway.generate');
    expect(gwSpans.length).toBeGreaterThan(0);
    expect(gwSpans[0].tier).toBe('quality');
  });

  it('includes metrics and highlights in prompt', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    const gwCalls = gateway.fetch.mock.calls;
    expect(gwCalls.length).toBeGreaterThan(0);
    const req = gwCalls[0][0] as Request;
    const reqBody = await req.text();
    const parsed = JSON.parse(reqBody);
    const prompt = parsed.messages[0].content;
    expect(prompt).toContain('Active learners: 45');
    expect(prompt).toContain('Average course progress: 62');
    expect(prompt).toContain('[positive]');
    expect(prompt).toContain('[warning]');
  });

  it('includes comparison note when previous period available', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    const req = gateway.fetch.mock.calls[0][0] as Request;
    const reqBody = await req.text();
    const parsed = JSON.parse(reqBody);
    const prompt = parsed.messages[0].content;
    expect(prompt).toContain('Previous period data is available');
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits data.fetch span with learner count', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans.length).toBe(1);
    expect(dataSpans[0].org_id).toBe('org-test');
    expect(dataSpans[0].total_learners).toBe(45);
    expect(dataSpans[0].progress_ok).toBe(true);
  });

  it('emits data.fetch with previous_ok flag', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans[0].previous_ok).toBe(true);
  });

  it('emits insight.generate span with ai_status', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const insightSpans = spans('insight.generate');
    expect(insightSpans.length).toBe(1);
    expect(insightSpans[0].ai_status).toBe('generated');
  });

  it('tracks lms_unreachable in data.fetch span', async () => {
    const e = mockEnv({ lmsError: true });
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans[0].lms_unreachable).toBe(true);
  });

  it('emits cohort_too_small when < 10 learners', async () => {
    const e = mockEnv({
      progress: { ...MOCK_PROGRESS, total_learners: 3 },
    });
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans[0].cohort_too_small).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
//  Edge Cases
// ════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('uses default period when not specified', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.period).toBe('last_30_days');
  });

  it('summary does not exceed reasonable length', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.summary.length).toBeLessThan(1000);
  });

  it('handles unparseable assessment topics', async () => {
    const e = mockEnv({
      assessments: { ...MOCK_ASSESSMENTS, topics: 'not json' },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.metrics.avg_quiz_score).toBe(73); // from overall
  });

  it('handles missing engagement data gracefully', async () => {
    const e = mockEnv({
      engagement: null,
      engagementStatus: 500,
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-analytics/admin/narrative?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('generated');
  });
});
