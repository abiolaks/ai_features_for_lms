import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createMockGateway, createLlmResponse, spyOnSpans } from '../../shared/test-utils';
import worker from '../src/index';

// ──── Response fixtures ────

const ENHANCE_RESPONSE = createLlmResponse([
  { course_title: 'Python Basics', why_this_fits: 'Matches your Python skill and ML goal.' },
  { course_title: 'Data Science Fundamentals', why_this_fits: 'Bridges your SQL skills into data science.' },
]);

const SCORING_RESPONSE = createLlmResponse([
  { course_title: 'Machine Learning 101', score: 92, reason: 'Directly advances your ML engineer goal.' },
  { course_title: 'Advanced Python', score: 75, reason: 'Deepens your existing Python skills.' },
  { course_title: 'Deep Learning', score: 40, reason: 'Too advanced before ML fundamentals.' },
]);

// ──── Span tracking ────

let logs: string[] = [];
let spans: ReturnType<typeof spyOnSpans>['spans'];

beforeEach(async () => {
  const s = spyOnSpans();
  logs = s.logs;
  spans = s.spans;
  (env as any).AI_GATEWAY = createMockGateway(SCORING_RESPONSE);
  delete (env as any).AI;
  delete (env as any).VECTORIZE_INDEX;
  // Clear KV between tests
  const keys = await (env as any).LMS_CACHE.list();
  for (const k of keys.keys) await (env as any).LMS_CACHE.delete(k.name);
});

// ──── Helpers ────

async function call(path: string, body: object) {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const TEST_PROFILE = {
  skills: ['python', 'sql'],
  goals: 'become a machine learning engineer',
  experience_level: 'intermediate',
};

const TEST_CATALOGUE = [
  { id: 'c1', title: 'Python Basics', difficulty: 'beginner', category: 'programming' },
  { id: 'c2', title: 'Data Science Fundamentals', difficulty: 'intermediate', category: 'data-science' },
  { id: 'c3', title: 'Machine Learning 101', difficulty: 'advanced', category: 'ai-ml', prerequisites: ['Data Science Fundamentals'] },
  { id: 'c4', title: 'Advanced Python', difficulty: 'advanced', category: 'programming', prerequisites: ['Python Basics'] },
  { id: 'c5', title: 'Deep Learning', difficulty: 'advanced', category: 'ai-ml', prerequisites: ['Machine Learning 101'] },
];

const TEST_PROGRESS = [
  { title: 'Python Basics', status: 'completed', progress_pct: 100 },
];

const TEST_LMS_RECS = [
  { course_id: 'c1', course_title: 'Python Basics', lms_reason: 'Popular in your org' },
  { course_id: 'c2', course_title: 'Data Science Fundamentals', lms_reason: 'Matches your interests' },
];

const BASE = { learner_id: 'l1', org_id: 'org1', profile: TEST_PROFILE, catalogue: TEST_CATALOGUE, progress: TEST_PROGRESS };

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects unknown paths', async () => {
    const res = await call('/unknown', BASE);
    expect(res.status).toBe(404);
  });

  it('rejects missing learner_id', async () => {
    const res = await call('/recommendations/dashboard', { org_id: 'org1' });
    expect(res.status).toBe(400);
  });

  it('rejects missing org_id', async () => {
    const res = await call('/recommendations/dashboard', { learner_id: 'l1' });
    expect(res.status).toBe(400);
  });

  it('rejects /next without course_id', async () => {
    const res = await call('/recommendations/next', { learner_id: 'l1', org_id: 'org1' });
    expect(res.status).toBe(400);
  });

  it('rejects DELETE method', async () => {
    const req = new Request('http://localhost/recommendations/dashboard', { method: 'DELETE' });
    const res = await worker.fetch(req, env as any);
    expect(res.status).toBe(405);
  });
});

// ════════════════════════════════════════════════════════
//  AI07 Enhance path — LMS recs present
// ════════════════════════════════════════════════════════

describe('Enhance path (LMS recs present)', () => {
  it('merges LMS reason with AI why_this_fits', async () => {
    (env as any).AI_GATEWAY = createMockGateway(ENHANCE_RESPONSE);
    const res = await call('/recommendations/dashboard', { ...BASE, lms_recommendations: TEST_LMS_RECS });
    const data = await res.json() as any;
    expect(data.ai_status).toBe('enhanced');
    expect(data.recommendations).toHaveLength(2);
    expect(data.recommendations[0].lms_reason).toBe('Popular in your org');
    expect(data.recommendations[0].ai_why_this_fits).toContain('Python');
  });

  it('prompt includes learner skills and goals', async () => {
    const gw = createMockGateway(ENHANCE_RESPONSE);
    (env as any).AI_GATEWAY = gw;
    await call('/recommendations/dashboard', { ...BASE, lms_recommendations: TEST_LMS_RECS });
    const sentBody = await (gw.fetch.mock.calls[0][0] as Request).json() as any;
    const prompt = sentBody.messages[0].content;
    expect(prompt).toContain('python, sql');
    expect(prompt).toContain('machine learning engineer');
    expect(prompt).toContain('Python Basics'); // completed course context
  });

  it('AI03 down → returns LMS recs without explanations, ai_status degraded', async () => {
    (env as any).AI_GATEWAY = createMockGateway(null, false);
    const res = await call('/recommendations/dashboard', { ...BASE, lms_recommendations: TEST_LMS_RECS });
    const data = await res.json() as any;
    expect(data.ai_status).toBe('degraded');
    expect(data.recommendations).toHaveLength(2);
    expect(data.recommendations[0].lms_reason).toBe('Popular in your org');
    expect(data.recommendations[0].ai_why_this_fits).toBe('');
  });
});

// ════════════════════════════════════════════════════════
//  AI07b engine — LMS recs empty
// ════════════════════════════════════════════════════════

describe('Fallback engine (LMS recs empty)', () => {
  it('generates recs from catalogue alone via AI scoring', async () => {
    const res = await call('/recommendations/dashboard', BASE);
    const data = await res.json() as any;
    expect(data.ai_status).toBe('generated');
    expect(data.recommendations.length).toBeGreaterThan(0);
    // Top rec should be highest AI score (ML 101 @ 92)
    expect(data.recommendations[0].course_title).toBe('Machine Learning 101');
    expect(data.recommendations[0].ai_why_this_fits).toContain('ML engineer goal');
    expect(data.recommendations[0].signals).toBeDefined();
  });

  it('excludes enrolled/completed courses from candidates', async () => {
    const res = await call('/recommendations/dashboard', BASE);
    const data = await res.json() as any;
    const titles = data.recommendations.map((r: any) => r.course_title);
    expect(titles).not.toContain('Python Basics');
  });

  it('AI03 down + no Vectorize → degraded, still returns candidates', async () => {
    (env as any).AI_GATEWAY = createMockGateway(null, false);
    const res = await call('/recommendations/dashboard', BASE);
    const data = await res.json() as any;
    expect(data.ai_status).toBe('degraded');
    expect(data.recommendations.length).toBeGreaterThan(0);
  });

  it('empty catalogue → ai_status unavailable', async () => {
    const res = await call('/recommendations/dashboard', { learner_id: 'l1', org_id: 'org1', catalogue: [] });
    const data = await res.json() as any;
    expect(data.ai_status).toBe('unavailable');
    expect(data.recommendations).toHaveLength(0);
  });

  it('content signal blends with AI score when Vectorize available', async () => {
    (env as any).AI = { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) };
    (env as any).VECTORIZE_INDEX = {
      query: vi.fn().mockResolvedValue({
        matches: [
          { id: 'v1', score: 0.9, metadata: { course_id: 'c4', org_id: 'org1' } },
          { id: 'v2', score: 0.8, metadata: { course_id: 'other-org', org_id: 'org2' } },
        ],
      }),
    };
    const res = await call('/recommendations/dashboard', BASE);
    const data = await res.json() as any;
    const advPython = data.recommendations.find((r: any) => r.course_title === 'Advanced Python');
    expect(advPython.signals.content_similarity).toBe(0.9);
    // org2 match must not leak in (org isolation)
    const contentSpan = spans('signal.content')[0];
    expect(contentSpan.matched_courses).toBe(1);
  });
});

// ════════════════════════════════════════════════════════
//  /recommendations/next
// ════════════════════════════════════════════════════════

describe('Next course', () => {
  it('returns next_courses with why_this_fits', async () => {
    const res = await call('/recommendations/next', { ...BASE, course_id: 'c1' });
    const data = await res.json() as any;
    expect(data.next_courses.length).toBeGreaterThan(0);
    expect(data.next_courses.length).toBeLessThanOrEqual(3);
    expect(data.next_courses[0]).toHaveProperty('why_this_fits');
  });

  it('boosts courses listing completed course as prerequisite', async () => {
    // Equal AI scores → prereq boost should put Advanced Python (prereq: Python Basics) on top
    (env as any).AI_GATEWAY = createMockGateway(createLlmResponse([
      { course_title: 'Advanced Python', score: 70, reason: 'Builds on Python Basics.' },
      { course_title: 'Deep Learning', score: 70, reason: 'Ambitious next step.' },
    ]));
    const res = await call('/recommendations/next', { ...BASE, course_id: 'c1' });
    const data = await res.json() as any;
    expect(data.next_courses[0].course_title).toBe('Advanced Python');
  });

  it('next prompt mentions the completed course', async () => {
    const gw = createMockGateway(SCORING_RESPONSE);
    (env as any).AI_GATEWAY = gw;
    await call('/recommendations/next', { ...BASE, course_id: 'c1' });
    const sentBody = await (gw.fetch.mock.calls[0][0] as Request).json() as any;
    expect(sentBody.messages[0].content).toContain('just completed "Python Basics"');
  });
});

// ════════════════════════════════════════════════════════
//  KV cache
// ════════════════════════════════════════════════════════

describe('KV cache', () => {
  it('second call hits cache (cache.hit span + source cache)', async () => {
    const gw = createMockGateway(SCORING_RESPONSE);
    (env as any).AI_GATEWAY = gw;
    await call('/recommendations/dashboard', BASE);
    const res2 = await call('/recommendations/dashboard', BASE);
    const data2 = await res2.json() as any;
    expect(data2.source).toBe('cache');
    expect(gw.fetch).toHaveBeenCalledTimes(1); // no second LLM call
    const lookups = spans('cache.lookup');
    expect(lookups[0]['cache.hit']).toBe(false);
    expect(lookups[1]['cache.hit']).toBe(true);
  });

  it('refresh=true bypasses cache', async () => {
    const gw = createMockGateway(SCORING_RESPONSE);
    (env as any).AI_GATEWAY = gw;
    await call('/recommendations/dashboard', BASE);
    await call('/recommendations/dashboard', { ...BASE, refresh: true });
    expect(gw.fetch).toHaveBeenCalledTimes(2);
  });

  it('degraded responses are not cached', async () => {
    (env as any).AI_GATEWAY = createMockGateway(null, false);
    await call('/recommendations/dashboard', BASE);
    // Recovery: gateway back up → fresh generation, not cached degraded copy
    (env as any).AI_GATEWAY = createMockGateway(SCORING_RESPONSE);
    const res = await call('/recommendations/dashboard', BASE);
    const data = await res.json() as any;
    expect(data.ai_status).toBe('generated');
    expect(data.source).toBe('fresh');
  });

  it('cache keys are scoped per learner and org', async () => {
    await call('/recommendations/dashboard', BASE);
    const res = await call('/recommendations/dashboard', { ...BASE, learner_id: 'l2' });
    const data = await res.json() as any;
    expect(data.source).toBe('fresh');
  });
});

// ════════════════════════════════════════════════════════
//  Observability
// ════════════════════════════════════════════════════════

describe('Observability', () => {
  it('cascade visible: data.fetch → signal spans → blend → recs.generate', async () => {
    await call('/recommendations/dashboard', BASE);
    expect(spans('data.fetch')).toHaveLength(1);
    expect(spans('signal.ai_scoring')).toHaveLength(1);
    expect(spans('score.blend')).toHaveLength(1);
    const top = spans('recs.generate')[0];
    expect(top.tier).toBe('engine');
    expect(top.ai_status).toBe('generated');
  });

  it('degraded marked in span with missing signals listed', async () => {
    (env as any).AI_GATEWAY = createMockGateway(null, false);
    await call('/recommendations/dashboard', BASE);
    const top = spans('recs.generate')[0];
    expect(top.ai_status).toBe('degraded');
    const blend = spans('score.blend')[0];
    expect(blend.ai_available).toBe(false);
    expect(blend.missing_signals).toContain('ai_score');
  });

  it('enhance tier visible when LMS recs present', async () => {
    (env as any).AI_GATEWAY = createMockGateway(ENHANCE_RESPONSE);
    await call('/recommendations/dashboard', { ...BASE, lms_recommendations: TEST_LMS_RECS });
    const top = spans('recs.generate')[0];
    expect(top.tier).toBe('enhance');
    expect(top.ai_status).toBe('enhanced');
  });
});
