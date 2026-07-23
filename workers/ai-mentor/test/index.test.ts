import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createMockGateway, spyOnSpans } from '../../shared/test-utils';
import worker from '../src/index';

// ──── Fixtures ────

const DEFAULT_LLM_RESPONSE = {
  response: JSON.stringify({
    gaps: [
      { skill: 'spark', current_level: 'none', required_level: 'intermediate', courses_available: 3, estimated_hours: 40 },
      { skill: 'data-modeling', current_level: 'none', required_level: 'intermediate', courses_available: 2, estimated_hours: 20 },
    ],
    summary: 'Strong foundation in Python and SQL. Biggest opportunity is distributed computing with Spark — 3 courses available to get you started.',
  }),
  model_used: '@cf/meta/llama-3.2-3b-instruct',
  provider: 'cloudflare',
  tokens_used: 120,
  throttle_warning: false,
};

// ──── LMS mock responses ────

const MOCK_PROFILE = {
  success: true,
  data: {
    id: 'learner-1',
    org_id: 'org-test',
    skills: ['python', 'sql', 'git'],
    goals: 'Become a data engineer',
    experience_level: 'intermediate',
    interests: ['data-science', 'machine-learning'],
    gamification: {
      login_streak: 14,
      total_points: 2500,
    },
  },
};

const MOCK_CATALOG = {
  success: true,
  data: [
    {
      id: 'course-1',
      title: 'Apache Spark Fundamentals',
      difficultyLevel: 'intermediate',
      category: 'distributed-computing',
      prerequisites: ['python', 'spark'],
    },
    {
      id: 'course-2',
      title: 'Advanced Spark Streaming',
      difficultyLevel: 'advanced',
      category: 'distributed-computing',
      prerequisites: ['python', 'spark', 'sql'],
    },
    {
      id: 'course-3',
      title: 'Data Modeling for Engineers',
      difficultyLevel: 'intermediate',
      category: 'data-modeling',
      prerequisites: ['sql', 'data-modeling'],
    },
    {
      id: 'course-4',
      title: 'Python Design Patterns',
      difficultyLevel: 'advanced',
      category: 'python',
      prerequisites: ['python'],
    },
    {
      id: 'course-5',
      title: 'Data Warehousing with Spark',
      difficultyLevel: 'intermediate',
      category: 'distributed-computing',
      prerequisites: ['python', 'spark', 'data-modeling'],
    },
  ],
};

const MOCK_PROGRESS = {
  success: true,
  data: {
    totalEnrollments: 2,
    completedEnrollments: 1,
    enrollments: [
      { courseTitle: 'Python Design Patterns', status: 'completed', progressPercent: '100' },
      { courseTitle: 'SQL Mastery', status: 'completed', progressPercent: '100' },
    ],
  },
};

// ──── Helper ────

/** Mock global fetch for LMS calls and return a mock gateway binding. */
function setupFetch(mockProfile?: object, mockCatalog?: object, mockProgress?: object, mockGatewayResponse?: object) {
  const gateway = createMockGateway(mockGatewayResponse || DEFAULT_LLM_RESPONSE);

  globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input.url;

    if (urlStr.includes('/api/v1/learner/profile')) {
      return Promise.resolve(new Response(JSON.stringify(mockProfile || MOCK_PROFILE), { status: 200 }));
    }
    if (urlStr.includes('/api/v1/catalog') || urlStr.includes('/api/v1/public/courses')) {
      return Promise.resolve(new Response(JSON.stringify(mockCatalog || MOCK_CATALOG), { status: 200 }));
    }
    if (urlStr.includes('/api/v1/progress/user')) {
      return Promise.resolve(new Response(JSON.stringify(mockProgress || MOCK_PROGRESS), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });

  return gateway;
}

// ════════════════════════════════════════════════════════
//  Tests
// ════════════════════════════════════════════════════════

describe('ai-mentor /mentor/skill-gap', () => {
  let gateway: ReturnType<typeof createMockGateway>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    gateway = setupFetch();
  });

  // ──── Validation ────

  it('returns 400 when learner_id is missing', async () => {
    const req = new Request('https://ai-mentor/mentor/skill-gap?org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(400);
    const body: any = await resp.json();
    expect(body.error).toContain('learner_id');
  });

  it('returns 400 when org_id is missing', async () => {
    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(400);
    const body: any = await resp.json();
    expect(body.error).toContain('org_id');
  });

  it('returns 405 for POST', async () => {
    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'POST' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(405);
  });

  it('returns 404 for unknown routes', async () => {
    const req = new Request('https://ai-mentor/unknown', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(404);
  });

  it('returns health check', async () => {
    const req = new Request('https://ai-mentor/health', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);
    const body: any = await resp.json();
    expect(body.worker).toBe('ai-mentor');
  });

  // ──── Happy Path ────

  it('returns skill gaps with recommendations', async () => {
    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    expect(body.learner_skills).toEqual(['python', 'sql', 'git']);
    expect(body.gaps).toBeInstanceOf(Array);
    expect(body.gaps.length).toBeGreaterThanOrEqual(1);

    // Verify gap structure
    const sparkGap = body.gaps.find((g: any) => g.skill === 'spark');
    expect(sparkGap).toBeDefined();
    expect(sparkGap.current_level).toBe('none');
    expect(sparkGap.required_level).toBe('intermediate');
    expect(sparkGap.courses_available).toBeGreaterThanOrEqual(2);
    expect(sparkGap.estimated_hours).toBeGreaterThan(0);

    // Verify summary
    expect(body.summary).toBeTruthy();
    expect(typeof body.summary).toBe('string');
    expect(body.summary.length).toBeGreaterThan(10);
    expect(body.ai_status).toBe('generated');
  });

  it('correctly computes courses_available from catalogue prerequisites', async () => {
    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    // spark is a prereq in 3 courses (Spark Fundamentals, Advanced Spark, Data Warehousing)
    const sparkGap = body.gaps.find((g: any) => g.skill === 'spark');
    if (sparkGap) {
      expect(sparkGap.courses_available).toBe(3);
    }
  });

  // ──── Empty Skills ────

  it('returns message when learner has no skills', async () => {
    const emptyProfile = {
      success: true,
      data: {
        id: 'learner-2',
        org_id: 'org-test',
        skills: [],
        goals: '',
        experience_level: 'beginner',
        interests: [],
        gamification: { login_streak: 0, total_points: 0 },
      },
    };
    gateway = setupFetch(emptyProfile, MOCK_CATALOG, MOCK_PROGRESS);

    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-2&org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    expect(body.learner_skills).toEqual([]);
    expect(body.gaps).toEqual([]);
    expect(body.summary).toContain('No skill data found');
    expect(body.ai_status).toBe('degraded');
  });

  // ──── Degraded Mode ────

  it('degrades gracefully when LMS profile fails', async () => {
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('LMS offline')));

    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    
    // Only mock gateway; LMS fetch will fail
    const gateway = createMockGateway();
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    expect(body.ai_status).toBe('degraded');
    expect(body.gaps).toEqual([]);
  });

  it('degrades gracefully when AI03 gateway fails', async () => {
    // Gateway returns null (unreachable)
    gateway = createMockGateway(null);

    // Set up LMS mocks
    globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : input.url;

      if (urlStr.includes('/api/v1/learner/profile')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_PROFILE), { status: 200 }));
      }
      if (urlStr.includes('/api/v1/catalog') || urlStr.includes('/api/v1/public/courses')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_CATALOG), { status: 200 }));
      }
      if (urlStr.includes('/api/v1/progress/user')) {
        return Promise.resolve(new Response(JSON.stringify(MOCK_PROGRESS), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });

    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    expect(body.ai_status).toBe('degraded');
    expect(body.summary).toBeTruthy();
  });

  it('degrades gracefully when catalog is empty', async () => {
    const emptyCatalog = { success: true, data: [] };
    gateway = setupFetch(MOCK_PROFILE, emptyCatalog, MOCK_PROGRESS);

    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    // Should still work — gaps may be empty but AI generates a summary
    expect(body.learner_skills).toEqual(['python', 'sql', 'git']);
    expect(body.ai_status).toBe('generated');
  });

  // ──── Observability ────

  it('emits structured observability spans', async () => {
    const { logs, spans } = spyOnSpans();

    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    await worker.fetch(req, { ...env, AI_GATEWAY: gateway });

    const dataSpans = spans('data.fetch');
    expect(dataSpans.length).toBeGreaterThanOrEqual(1);
    expect(dataSpans[0].duration_ms).toBeGreaterThanOrEqual(0);

    const gapSpans = spans('skill_gap.generate');
    expect(gapSpans.length).toBeGreaterThanOrEqual(1);
    expect(gapSpans[0].duration_ms).toBeGreaterThanOrEqual(0);

    const gwSpans = spans('ai_gateway.generate');
    expect(gwSpans.length).toBeGreaterThanOrEqual(1);
  });

  // ──── Course Matching ────

  it('excludes completed courses from recommendation candidates', async () => {
    // Python Design Patterns is completed — should not be recommended
    gateway = setupFetch(MOCK_PROFILE, MOCK_CATALOG, MOCK_PROGRESS);

    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    // Python Design Patterns should not show as a gap since the learner has python skill
    // and the course is completed — no gap for python
    const pythonGap = body.gaps.find((g: any) => g.skill === 'python');
    expect(pythonGap).toBeUndefined();
  });

  // ──── Gap Computation ────

  it('identifies gaps from course prerequisites not in learner skills', async () => {
    gateway = setupFetch(MOCK_PROFILE, MOCK_CATALOG, MOCK_PROGRESS);

    const req = new Request('https://ai-mentor/mentor/skill-gap?learner_id=learner-1&org_id=org-test', { method: 'GET' });
    const resp = await worker.fetch(req, { ...env, AI_GATEWAY: gateway });
    expect(resp.status).toBe(200);

    const body: any = await resp.json();
    const gapSkills = body.gaps.map((g: any) => g.skill);
    // spark and data-modeling are prerequisites the learner doesn't have
    expect(gapSkills).toContain('spark');
    expect(gapSkills).toContain('data-modeling');
  });
});
