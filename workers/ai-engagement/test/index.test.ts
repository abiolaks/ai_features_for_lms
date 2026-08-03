// ============================================================
// F04b: Engagement Monitoring — Test Suite
// ============================================================

import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import {
  env,
  createExecutionContext,
} from 'cloudflare:test';
import { createMockGateway, createLlmResponse, spyOnSpans } from '../../shared/test-utils';
import worker from '../src/index';

// ── Mock LMS engagement data ──

const MOCK_LMS_ENGAGEMENT = {
  period: 'last_30_days',
  total_active_learners: 45,
  course_engagement: [
    {
      course_id: 'course-1',
      course_title: 'Python Basics',
      enrolled_learners: 30,
      completion_rate: 0.45,
      avg_time_per_week_minutes: 30,
      stall_rate: 0.25,
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
    {
      video_id: 'vid-2',
      video_title: 'Neural Networks Explained',
      course_title: 'Advanced ML',
      views: 45,
      avg_watch_percent: 82,
      drop_off_at_seconds: null,
      completion_rate: 0.78,
    },
  ],
  activity_patterns: {
    by_hour: { '8': 15, '9': 45, '10': 60, '14': 55, '22': 5 },
    by_day_of_week: { monday: 120, tuesday: 110, wednesday: 95, sunday: 20 },
    peak_hour: 10,
    peak_day: 'monday',
    off_peak_hours: [0, 1, 2, 3, 4, 5, 22, 23],
  },
  overall: {
    avg_completion_rate: 0.48,
    avg_time_per_week_minutes: 52,
    total_videos_watched: 450,
  },
};

const MOCK_LLM_INSIGHTS = {
  insights: [
    {
      type: 'video_dropoff',
      severity: 'high',
      finding: 'Video completion drops 40% after 15 minutes in Python Basics',
      suggestion: 'Split videos longer than 15 min into shorter segments',
      affected_learners: 120,
      evidence: 'Intro to Variables drops to 38% completion, with drop-off at 15:00',
    },
    {
      type: 'course_stall',
      severity: 'medium',
      finding: 'Python Basics has 25% stall rate with only 45% completion',
      suggestion: 'Add check-in quizzes after module 3 to re-engage learners',
      affected_learners: 30,
      evidence: '25% of enrolled learners have stalled, completion rate is 45%',
    },
    {
      type: 'timing_pattern',
      severity: 'low',
      finding: 'Low engagement during late-night hours (22:00–05:00)',
      suggestion: 'Schedule maintenance and content updates during off-peak hours',
      affected_learners: 45,
      evidence: 'Activity drops to 5 sessions at 22:00 vs 60 at peak hour 10:00',
    },
  ],
};

// ── Helper: build a mocked env ──

function mockEnv(overrides: {
  lmsData?: any;
  lmsStatus?: number;
  lmsError?: boolean;
  gatewayResponse?: object | null;
  gatewayOk?: boolean;
} = {}) {
  const {
    lmsData = MOCK_LMS_ENGAGEMENT,
    lmsStatus = 200,
    lmsError = false,
    gatewayResponse = MOCK_LLM_INSIGHTS,
    gatewayOk = true,
  } = overrides;

  // LMS fetch
  const lmsFetch = lmsError
    ? vi.fn(() => Promise.reject(new Error('Connection refused')))
    : vi.fn((input: any) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
        if (url.includes('/admin/engagement')) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: 'ok', data: lmsData }), {
              status: lmsStatus,
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
    const resp = await worker.fetch(new Request('https://ai-engagement/admin/engagement', { method: 'POST' }), e, ctx);
    expect(resp.status).toBe(405);
    const body = (await resp.json()) as any;
    expect(body.error).toBe('method_not_allowed');
  });

  it('rejects unknown paths', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(new Request('https://ai-engagement/nope'), e, ctx);
    expect(resp.status).toBe(404);
  });

  it('rejects missing org_id', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(new Request('https://ai-engagement/admin/engagement'), e, ctx);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain('org_id');
  });

  it('health endpoint works', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(new Request('https://ai-engagement/health'), e, ctx);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.worker).toBe('ai-engagement');
  });
});

// ════════════════════════════════════════════════════════
//  Happy Path
// ════════════════════════════════════════════════════════

describe('Happy path', () => {
  it('returns 200 with insights and learner_count', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test&period=last_30_days'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.org_id).toBe('org-test');
    expect(body.period).toBe('last_30_days');
    expect(body.learner_count).toBe(45);
    expect(body.insights).toBeInstanceOf(Array);
    expect(body.insights.length).toBeGreaterThan(0);
    expect(body.ai_status).toBe('generated');
  });

  it('each insight has all required fields', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    for (const insight of body.insights) {
      expect(insight).toHaveProperty('type');
      expect(insight).toHaveProperty('severity');
      expect(insight).toHaveProperty('finding');
      expect(insight).toHaveProperty('suggestion');
      expect(insight).toHaveProperty('affected_learners');
      expect(insight).toHaveProperty('evidence');

      expect(['video_dropoff', 'course_stall', 'timing_pattern']).toContain(insight.type);
      expect(['high', 'medium', 'low']).toContain(insight.severity);
      expect(typeof insight.finding).toBe('string');
      expect(insight.finding.length).toBeGreaterThan(0);
      expect(typeof insight.suggestion).toBe('string');
      expect(insight.suggestion.length).toBeGreaterThan(0);
      expect(typeof insight.affected_learners).toBe('number');
      expect(typeof insight.evidence).toBe('string');
      expect(insight.evidence.length).toBeGreaterThan(0);
    }
  });

  it('identifies video drop-off points (completion <60%)', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    const dropoffs = body.insights.filter((i: any) => i.type === 'video_dropoff');
    expect(dropoffs.length).toBeGreaterThan(0);

    // Completion at 38% → medium severity (30-50% band)
    const first = dropoffs[0];
    expect(['high', 'medium']).toContain(first.severity);
    expect(first.affected_learners).toBe(120);
  });

  it('identifies stall patterns (stall_rate >25%)', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    const stalls = body.insights.filter((i: any) => i.type === 'course_stall');
    expect(stalls.length).toBeGreaterThan(0);
    expect(stalls[0].finding).toMatch(/Python|stall/i);
  });

  it('identifies timing patterns from activity data', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;

    const timing = body.insights.filter((i: any) => i.type === 'timing_pattern');
    // LLM generates timing insight from off-peak data
    expect(timing.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════
//  Cohort & Anonymity
// ════════════════════════════════════════════════════════

describe('Cohort and anonymity', () => {
  it('returns insufficient_data when total learners < 10', async () => {
    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, total_active_learners: 9 },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('insufficient_data');
    expect(body.insights).toEqual([]);
  });

  it('returns insufficient_data when total_learners is 0', async () => {
    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, total_active_learners: 0 },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('insufficient_data');
  });

  it('no individual learner data in response', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/\buser[-_]\d+\b/);
    expect(text).not.toMatch(/\blearner[-_]\d+\b/);
  });

  it('accepts engagement when learner count is exactly at minimum', async () => {
    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, total_active_learners: 10 },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('generated');
    expect(body.insights.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns degraded when LMS is unreachable', async () => {
    const e = mockEnv({ lmsError: true, gatewayResponse: MOCK_LLM_INSIGHTS });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.learner_count).toBe(0);
  });

  it('returns degraded when AI gateway fails', async () => {
    const e = mockEnv({ gatewayOk: false });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.insights.length).toBeGreaterThan(0);
  });

  it('returns skeleton insights when LLM returns non-JSON', async () => {
    const e = mockEnv({
      gatewayResponse: 'Sure! Here are some insights...',
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('degraded');
    expect(body.insights.length).toBeGreaterThan(0);
  });

  it('returns none_needed when no patterns detected and no AI needed', async () => {
    const e = mockEnv({
      lmsData: {
        ...MOCK_LMS_ENGAGEMENT,
        video_engagement: MOCK_LMS_ENGAGEMENT.video_engagement.map((v) => ({
          ...v, completion_rate: 0.85,
        })),
        course_engagement: MOCK_LMS_ENGAGEMENT.course_engagement.map((c) => ({
          ...c, stall_rate: 0.05, completion_rate: 0.80,
        })),
        activity_patterns: {
          by_hour: {}, by_day_of_week: {},
          peak_hour: null, peak_day: null, off_peak_hours: [],
        },
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('none_needed');
    expect(body.insights).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════
//  Threshold Logic
// ════════════════════════════════════════════════════════

describe('Threshold logic', () => {
  it('does not flag video at exactly 60% completion', async () => {
    const e = mockEnv({
      lmsData: {
        ...MOCK_LMS_ENGAGEMENT,
        video_engagement: [{
          video_id: 'vid-1', video_title: 'Borderline Video',
          course_title: 'Python Basics', views: 50,
          avg_watch_percent: 60, drop_off_at_seconds: 600,
          completion_rate: 0.60,
        }],
        course_engagement: MOCK_LMS_ENGAGEMENT.course_engagement.map((c) => ({ ...c, stall_rate: 0.05 })),
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    const dropoffs = body.insights.filter((i: any) => i.type === 'video_dropoff');
    expect(dropoffs.length).toBe(0);
  });

  it('flags video drop-off just below 60% threshold', async () => {
    const e = mockEnv({
      lmsData: {
        ...MOCK_LMS_ENGAGEMENT,
        video_engagement: [{
          video_id: 'vid-1', video_title: 'Low Video',
          course_title: 'Python Basics', views: 50,
          avg_watch_percent: 59, drop_off_at_seconds: 600,
          completion_rate: 0.59,
        }],
        course_engagement: MOCK_LMS_ENGAGEMENT.course_engagement.map((c) => ({ ...c, stall_rate: 0.05 })),
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    const dropoffs = body.insights.filter((i: any) => i.type === 'video_dropoff');
    expect(dropoffs.length).toBeGreaterThan(0);
  });

  it('flags course stall at exactly 25%', async () => {
    const e = mockEnv({
      lmsData: {
        ...MOCK_LMS_ENGAGEMENT,
        course_engagement: [{
          course_id: 'course-1', course_title: 'Stall Course',
          enrolled_learners: 30, completion_rate: 0.50,
          avg_time_per_week_minutes: 25, stall_rate: 0.25,
        }],
        video_engagement: MOCK_LMS_ENGAGEMENT.video_engagement.map((v) => ({ ...v, completion_rate: 0.85 })),
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    const stalls = body.insights.filter((i: any) => i.type === 'course_stall');
    expect(stalls.length).toBeGreaterThan(0);
  });

  it('does not flag course stall below 25%', async () => {
    const e = mockEnv({
      lmsData: {
        ...MOCK_LMS_ENGAGEMENT,
        course_engagement: [{
          course_id: 'course-1', course_title: 'Healthy Course',
          enrolled_learners: 30, completion_rate: 0.80,
          avg_time_per_week_minutes: 40, stall_rate: 0.24,
        }],
        video_engagement: MOCK_LMS_ENGAGEMENT.video_engagement.map((v) => ({ ...v, completion_rate: 0.85 })),
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    const stalls = body.insights.filter((i: any) => i.type === 'course_stall');
    expect(stalls.length).toBe(0);
  });

  it('handles null drop_off_at_seconds gracefully', async () => {
    const e = mockEnv({
      lmsData: {
        ...MOCK_LMS_ENGAGEMENT,
        video_engagement: [{
          video_id: 'vid-1', video_title: 'No Drop-off',
          course_title: 'Python', views: 30,
          avg_watch_percent: 55, drop_off_at_seconds: null,
          completion_rate: 0.55,
        }],
        course_engagement: MOCK_LMS_ENGAGEMENT.course_engagement.map((c) => ({ ...c, stall_rate: 0.05 })),
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('generated');
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('includes video drop-off data in prompt', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const gateway = e.AI_GATEWAY as any;
    const gwCalls = gateway.fetch.mock.calls;
    expect(gwCalls.length).toBeGreaterThan(0);
    // Request body is a ReadableStream — read it
    const req = gwCalls[0][0] as Request;
    const reqBody = await req.text();
    const parsed = JSON.parse(reqBody);
    const prompt = parsed.messages[0].content;
    expect(prompt).toContain('video_dropoff');
    expect(prompt).toContain('Intro to Variables');
  });

  it('uses standard tier', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const gwSpans = spans('ai_gateway.generate');
    expect(gwSpans.length).toBeGreaterThan(0);
    expect(gwSpans[0].tier).toBe('standard');
  });

  it('handles empty engagement data gracefully in prompt', async () => {
    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, video_engagement: [], course_engagement: [] },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits data.fetch span with learner count and data source flags', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans.length).toBe(1);
    expect(dataSpans[0].org_id).toBe('org-test');
    expect(dataSpans[0].period).toBe('last_30_days');
    expect(dataSpans[0].total_learners).toBe(45);
  });

  it('emits data.fetch span with cohort_too_small when < 10 learners', async () => {
    const e = mockEnv({ lmsData: { ...MOCK_LMS_ENGAGEMENT, total_active_learners: 3 } });
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans[0].cohort_too_small).toBe(true);
  });

  it('emits insight.generate span with pattern count and ai_status', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const insightSpans = spans('insight.generate');
    expect(insightSpans.length).toBe(1);
    expect(insightSpans[0].ai_status).toBe('generated');
  });

  it('emits insight.generate span with degraded when gateway fails', async () => {
    const e = mockEnv({ gatewayOk: false });
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const insightSpans = spans('insight.generate');
    expect(insightSpans.length).toBe(1);
    expect(insightSpans[0].ai_status).toBe('degraded');
  });

  it('emits ai_gateway.generate sub-span', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const gwSpans = spans('ai_gateway.generate');
    expect(gwSpans.length).toBe(1);
  });

  it('tracks lms_unreachable in data.fetch span', async () => {
    const e = mockEnv({ lmsError: true, gatewayResponse: MOCK_LLM_INSIGHTS });
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans[0].lms_unreachable).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
//  Partial LMS Data
// ════════════════════════════════════════════════════════

describe('Partial LMS data', () => {
  it('works with only course data (no videos)', async () => {
    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, video_engagement: [] },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.learner_count).toBe(45);
    expect(body.ai_status).toBe('generated');

    const videoDropoffs = body.insights.filter((i: any) => i.type === 'video_dropoff');
    expect(videoDropoffs.length).toBe(0);
  });

  it('works with only video data (no courses)', async () => {
    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, course_engagement: [] },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('generated');

    const stalls = body.insights.filter((i: any) => i.type === 'course_stall');
    expect(stalls.length).toBe(0);
  });

  it('data.fetch span tracks missing data sections', async () => {
    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, video_engagement: [] },
    });
    const ctx = createExecutionContext();
    const { spans } = spyOnSpans();

    await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );

    const dataSpans = spans('data.fetch');
    expect(dataSpans[0].video_count).toBe(0);
    expect(dataSpans[0].course_count).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════
//  Edge Cases
// ════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('handles missing activity_patterns gracefully', async () => {
    const e = mockEnv({
      lmsData: {
        ...MOCK_LMS_ENGAGEMENT,
        activity_patterns: {
          by_hour: {}, by_day_of_week: {},
          peak_hour: null, peak_day: null, off_peak_hours: [],
        },
      },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ai_status).toBe('generated');
  });

  it('caps insights at a reasonable number', async () => {
    const manyVideos = Array.from({ length: 20 }, (_, i) => ({
      video_id: `vid-${i}`, video_title: `Video ${i}`,
      course_title: 'Python Basics', views: 50,
      avg_watch_percent: 30 + i, drop_off_at_seconds: 600,
      completion_rate: 0.30,
    }));

    const e = mockEnv({
      lmsData: { ...MOCK_LMS_ENGAGEMENT, video_engagement: manyVideos, course_engagement: [] },
    });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    const body = (await resp.json()) as any;
    expect(body.insights.length).toBeLessThanOrEqual(15);
  });

  it('uses default period when not specified', async () => {
    const e = mockEnv();
    const ctx = createExecutionContext();
    const resp = await worker.fetch(
      new Request('https://ai-engagement/admin/engagement?org_id=org-test'),
      e, ctx,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.period).toBe('last_30_days');
  });
});
