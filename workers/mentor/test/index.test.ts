import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createMockGateway, createLlmResponse, spyOnSpans } from '../../shared/test-utils';
import worker from '../src/index';

// ──── Fixtures ────

const DEFAULT_GAP_RESPONSE = createLlmResponse({
  gaps: [
    {
      skill: "spark",
      current_level: "none",
      required_level: "intermediate",
      courses_available: 2,
      estimated_hours: 40,
    },
    {
      skill: "machine learning",
      current_level: "beginner",
      required_level: "intermediate",
      courses_available: 3,
      estimated_hours: 60,
    },
  ],
  summary: "Strong in Python and SQL. Biggest gap is distributed computing. 3 courses available.",
});

let spanLogs: string[] = [];
let spans: ReturnType<typeof spyOnSpans>['spans'];

beforeAll(() => {
  (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);
});

beforeEach(() => {
  const s = spyOnSpans();
  spanLogs = s.logs;
  spans = s.spans;
});

// ──── Helpers ────

async function call(body: object) {
  const req = new Request('http://localhost/mentor/skill-gap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const TEST_PROFILE = {
  skills: ["python", "sql"],
  goals: "become a data engineer",
  experience_level: "intermediate",
  streak_days: 12,
  points: 500,
  interests: ["data-engineering", "python"],
};

const TEST_CATALOGUE = [
  { title: "Python Basics", difficulty: "beginner", category: "programming" },
  { title: "Data Science Fundamentals", difficulty: "intermediate", category: "data-science", prerequisites: ["Python Basics"] },
  { title: "Spark for Big Data", difficulty: "intermediate", category: "data-engineering" },
  { title: "Machine Learning 101", difficulty: "advanced", category: "ai-ml", prerequisites: ["Data Science Fundamentals"] },
  { title: "SQL for Data", difficulty: "beginner", category: "data-science" },
  { title: "Deep Learning", difficulty: "advanced", category: "ai-ml", prerequisites: ["Machine Learning 101"] },
];

const TEST_PROGRESS = [
  { title: "Python Basics", status: "completed" as const, progress_pct: 100 },
  { title: "SQL for Data", status: "in_progress" as const, progress_pct: 60 },
];

const BASE = { learner_id: 'l1', org_id: 'org1', profile: TEST_PROFILE, catalogue: TEST_CATALOGUE, progress: TEST_PROGRESS };

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects non-GET/POST methods', async () => {
    const req = new Request('http://localhost/mentor/skill-gap?learner_id=l1&org_id=org1', {
      method: 'DELETE',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
  });

  it('rejects unknown paths', async () => {
    const req = new Request('http://localhost/unknown', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON on POST', async () => {
    const req = new Request('http://localhost/mentor/skill-gap', {
      method: 'POST',
      body: 'not json',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('rejects missing learner_id', async () => {
    const res = await call({ org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('learner_id');
  });

  it('rejects missing org_id', async () => {
    const res = await call({ learner_id: 'l1' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('org_id');
  });

  it('accepts GET with query params', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);
    const req = new Request('http://localhost/mentor/skill-gap?learner_id=l1&org_id=org1', {
      method: 'GET',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.learner_skills).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════
//  No Skills — Empty State
// ════════════════════════════════════════════════════════

describe('No skills — empty state', () => {
  it('returns message when learner has no skills', async () => {
    const res = await call({
      learner_id: 'l1',
      org_id: 'org1',
      profile: { skills: [], goals: "learn data engineering", experience_level: "beginner" },
      catalogue: TEST_CATALOGUE,
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.learner_skills).toEqual([]);
    expect(body.gaps).toEqual([]);
    expect(body.summary).toContain('No skills found');
  });

  it('returns message when learner has no skills and no goals', async () => {
    const res = await call({
      learner_id: 'l1',
      org_id: 'org1',
      profile: { skills: [], goals: "", experience_level: "beginner" },
      catalogue: TEST_CATALOGUE,
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.learner_skills).toEqual([]);
    expect(body.gaps).toEqual([]);
    expect(body.summary).toContain('No skills found');
  });
});

// ════════════════════════════════════════════════════════
//  Insufficient Data
// ════════════════════════════════════════════════════════

describe('Insufficient data', () => {
  it('returns empty gaps when no catalogue', async () => {
    const res = await call({
      learner_id: 'l1',
      org_id: 'org1',
      profile: TEST_PROFILE,
      catalogue: [],
    });

    const body: any = await res.json();
    expect(body.learner_skills).toEqual(["python", "sql"]);
    expect(body.gaps).toEqual([]);
    expect(body.summary).toContain('No courses');
  });
});

// ════════════════════════════════════════════════════════
//  Gap Analysis — Happy Path
// ════════════════════════════════════════════════════════

describe('Gap analysis', () => {
  it('returns gaps and summary from LLM', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);

    const res = await call(BASE);
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body.learner_skills).toEqual(["python", "sql"]);
    expect(body.gaps.length).toBeGreaterThanOrEqual(1);
    expect(body.gaps[0]).toHaveProperty('skill');
    expect(body.gaps[0]).toHaveProperty('current_level');
    expect(body.gaps[0]).toHaveProperty('required_level');
    expect(body.gaps[0]).toHaveProperty('courses_available');
    expect(body.gaps[0]).toHaveProperty('estimated_hours');
    expect(body.summary).toBeTruthy();
  });

  it('accepts gaps for skills learner already has (LLM refines)', async () => {
    // LLM returns a gap for "python" which the learner already has
    (env as any).AI_GATEWAY = createMockGateway(createLlmResponse({
      gaps: [
        { skill: "python", current_level: "intermediate", required_level: "expert", courses_available: 1, estimated_hours: 20 },
        { skill: "spark", current_level: "none", required_level: "intermediate", courses_available: 2, estimated_hours: 40 },
      ],
      summary: "Already strong in Python. Spark is the key gap.",
    }));

    const res = await call(BASE);
    const body: any = await res.json();

    // python gap should be present (learner has intermediate, LLM says expert needed)
    const pythonGap = body.gaps.find((g: any) => g.skill === 'python');
    expect(pythonGap).toBeDefined();
    expect(pythonGap.current_level).toBe('intermediate');
    // Spark should be present
    expect(body.gaps.some((g: any) => g.skill === 'spark')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns computed gaps when gateway fails', async () => {
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    const res = await call(BASE);
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body.learner_skills).toEqual(["python", "sql"]);
    expect(body.gaps.length).toBeGreaterThanOrEqual(0);
    expect(body.summary).toContain('unavailable');
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    (env as any).AI_GATEWAY = createMockGateway({
      response: "Here's a nice analysis... no JSON here!",
      model_used: "llama",
      provider: "cloudflare",
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await call(BASE);
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body.learner_skills).toBeDefined();
    expect(body.gaps).toBeDefined();
    expect(body.summary).toContain('unavailable');
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('includes learner skills + catalogue in prompt', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await call(BASE);

    expect(spy).toHaveBeenCalled();
    const callBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = callBody.messages[0].content;

    expect(prompt).toContain('python');
    expect(prompt).toContain('sql');
    expect(prompt).toContain('data engineer');
    expect(prompt).toContain('Spark for Big Data');
    expect(prompt).toContain('Machine Learning 101');
    expect(prompt).toContain('Completed courses');
    expect(prompt).toContain('In-progress');
  });

  it('handles minimal profile gracefully', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await call({
      learner_id: 'l2',
      org_id: 'org1',
      profile: { skills: ["excel"], goals: "", experience_level: "beginner" },
      catalogue: TEST_CATALOGUE,
    });

    expect(spy).toHaveBeenCalled();
    const callBody = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = callBody.messages[0].content;
    expect(prompt).toContain('excel');
    expect(prompt).toContain('beginner');
    expect(prompt).toContain('none listed'); // goals
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits data.fetch span with profile + catalogue + progress info', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);

    await call(BASE);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    expect(dataSpan).toBeDefined();
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.learner_id).toBe('l1');
    expect(parsed.org_id).toBe('org1');
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits gap.analyze span with result metrics', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);

    await call(BASE);

    const gapSpan = spanLogs.find((l) => l.includes('"span":"gap.analyze"'));
    expect(gapSpan).toBeDefined();
    const parsed = JSON.parse(gapSpan!);
    expect(parsed.gap_count).toBeGreaterThanOrEqual(1);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits gap.analyze span with degraded status when gateway fails', async () => {
    (env as any).AI_GATEWAY = createMockGateway({}, false);

    await call(BASE);

    const gapSpan = spanLogs.find((l) => l.includes('"span":"gap.analyze"'));
    expect(gapSpan).toBeDefined();
    const parsed = JSON.parse(gapSpan!);
    expect(parsed.ai_status).toBe('degraded');
    expect(parsed.ai_gateway_error).toBe(true);
  });

  it('emits ai_gateway.generate sub-span', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);

    await call(BASE);

    const gwSpan = spanLogs.find((l) => l.includes('"span":"ai_gateway.generate"'));
    expect(gwSpan).toBeDefined();
    const parsed = JSON.parse(gwSpan!);
    expect(parsed.tier).toBe('standard');
    expect(parsed.status).toBe(200);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits lms.fetch sub-spans for profile, catalog, and progress', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);

    await call(BASE);

    const lmsSpans = spans('lms.fetch');
    expect(lmsSpans.length).toBeGreaterThanOrEqual(3);

    const endpoints = lmsSpans.map((s: any) => s.endpoint);
    expect(endpoints).toContain('profile');
    expect(endpoints).toContain('catalog');
    expect(endpoints).toContain('progress');
  });

  it('emits data.fetch span with has_skills flag', async () => {
    (env as any).AI_GATEWAY = createMockGateway(DEFAULT_GAP_RESPONSE);

    await call(BASE);

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.has_skills).toBe(true);
    expect(parsed.catalogue_courses).toBeGreaterThan(0);
  });
});
