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
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      })
    ),
  };
}

const DEFAULT_LLM_RESPONSE = {
  response: JSON.stringify({
    courses: [
      { course_title: "Python Basics", order: 1, why_this_fits: "Builds foundation for your ML goal." },
      { course_title: "Data Science Fundamentals", order: 2, why_this_fits: "Bridges Python to ML concepts." },
    ],
  }),
  model_used: "@cf/meta/llama-3.2-3b-instruct",
  provider: "cloudflare",
  tokens_used: 120,
  throttle_warning: false,
};

// ──── Span tracking — captures structured console.log ────

let spanLogs: string[] = [];

function mockConsoleLog(...args: unknown[]) {
  spanLogs.push(String(args[0]));
}

beforeAll(() => {
  (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
});

beforeEach(() => {
  spanLogs = [];
  vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
});

// ──── Helpers ────

async function generate(body: object) {
  const req = new Request('http://localhost/paths/generate', {
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
  goals: "become a machine learning engineer",
  experience_level: "intermediate",
  streak_days: 12,
};

const TEST_CATALOGUE = [
  { title: "Python Basics", difficulty: "beginner", category: "programming" },
  { title: "Data Science Fundamentals", difficulty: "intermediate", category: "data-science", prerequisites: ["Python Basics"] },
  { title: "Machine Learning 101", difficulty: "advanced", category: "ai-ml", prerequisites: ["Data Science Fundamentals"] },
  { title: "Advanced Python", difficulty: "advanced", category: "programming", prerequisites: ["Python Basics"] },
  { title: "SQL for Data", difficulty: "beginner", category: "data-science" },
  { title: "Deep Learning", difficulty: "advanced", category: "ai-ml", prerequisites: ["Machine Learning 101"] },
];

const TEST_PROGRESS = [
  { title: "Python Basics", status: "completed", progress_pct: 100 },
  { title: "SQL for Data", status: "in_progress", progress_pct: 60 },
];

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects GET', async () => {
    const req = new Request('http://localhost/paths/generate', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
  });

  it('rejects unknown paths', async () => {
    const req = new Request('http://localhost/unknown', { method: 'POST', body: '{}' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('http://localhost/paths/generate', { method: 'POST', body: 'not json' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('rejects missing learner_id', async () => {
    const res = await generate({ org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('learner_id');
  });

  it('rejects missing org_id', async () => {
    const res = await generate({ learner_id: 'l1' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toContain('org_id');
  });
});

// ════════════════════════════════════════════════════════
//  Insufficient Data
// ════════════════════════════════════════════════════════

describe('Insufficient data', () => {
  it('returns insufficient_data when no catalogue', async () => {
    const res = await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: [],
    });

    const body: any = await res.json();
    expect(body.ai_status).toBe('insufficient_data');
    expect(body.path).toEqual([]);
  });

  it('returns browse view when no profile', async () => {
    const res = await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      catalogue: TEST_CATALOGUE,
    });

    const body: any = await res.json();
    expect(body.ai_status).toBe('insufficient_data');
    expect(body.path.length).toBeGreaterThan(0);
    expect(body.path[0].why_this_fits).toContain('Add skills');
  });
});

// ════════════════════════════════════════════════════════
//  Path Generation
// ════════════════════════════════════════════════════════

describe('Path generation', () => {
  it('generates path from profile + catalogue + progress', async () => {
    // Use a clean mock with courses that work with the test data
    (env as any).AI_GATEWAY = mockAiGateway({
      response: JSON.stringify({
        courses: [
          { course_title: "Data Science Fundamentals", order: 1, why_this_fits: "Bridges skills to ML." },
          { course_title: "Machine Learning 101", order: 2, why_this_fits: "Your target domain." },
        ],
      }),
      model_used: "llama", provider: "cloudflare", tokens_used: 80, throttle_warning: false,
    });

    const res = await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ai_status).toBe('generated');
    expect(body.path.length).toBeGreaterThanOrEqual(1);
    expect(body.path[0].course_title).toBeTruthy();
    expect(body.path[0].order).toBe(1);
    expect(body.path[0].why_this_fits).toBeTruthy();
  });

  it('excludes completed courses from path', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({
      response: JSON.stringify({
        courses: [
          { course_title: "Python Basics", order: 1, why_this_fits: "Foundation." },
          { course_title: "Advanced Python", order: 2, why_this_fits: "Next step." },
        ],
      }),
      model_used: "llama", provider: "cloudflare", tokens_used: 60, throttle_warning: false,
    });

    const catalogue = [
      { title: "Python Basics", difficulty: "beginner", category: "programming" },
      { title: "Advanced Python", difficulty: "advanced", category: "programming", prerequisites: ["Python Basics"] },
    ];
    const progress = [
      { title: "Python Basics", status: "completed", progress_pct: 100 },
    ];

    const res = await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue,
      progress,
    });

    const body: any = await res.json();
    const titles = body.path.map((c: any) => c.course_title);
    expect(titles).not.toContain("Python Basics");
  });

  it('validates prerequisite ordering', async () => {
    // LLM returns courses in wrong order
    (env as any).AI_GATEWAY = mockAiGateway({
      response: JSON.stringify({
        courses: [
          { course_title: "Machine Learning 101", order: 1, why_this_fits: "..." },
          { course_title: "Python Basics", order: 2, why_this_fits: "..." },
        ],
      }),
      model_used: "llama",
      provider: "cloudflare",
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: [],
    });

    const body: any = await res.json();
    // ML 101 requires Data Science Fundamentals which requires Python Basics
    // Python Basics should not be after ML 101
    const titles = body.path.map((c: any) => c.course_title);
    // ML 101 should be filtered out (prereqs not met before it appears)
    expect(titles).not.toContain("Machine Learning 101");
  });
});

// ════════════════════════════════════════════════════════
//  Degraded Mode
// ════════════════════════════════════════════════════════

describe('Degraded mode', () => {
  it('returns catalogue without AI when gateway fails', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({}, false);

    const res = await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    const body: any = await res.json();
    expect(body.ai_status).toBe('degraded');
    expect(body.path.length).toBeGreaterThan(0);
    expect(body.path[0].why_this_fits).toBe("");
  });

  it('returns degraded when LLM returns non-JSON', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({
      response: "Here's a nice path for you... no JSON here!",
      model_used: "llama",
      provider: "cloudflare",
      tokens_used: 50,
      throttle_warning: false,
    });

    const res = await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    const body: any = await res.json();
    expect(body.ai_status).toBe('degraded');
    // Should fallback to catalogue order
    expect(body.path.length).toBeGreaterThan(0);
    // No why_this_fits when LLM returns garbage
    expect(body.path.every((c: any) => !c.why_this_fits)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
//  Prompt Construction
// ════════════════════════════════════════════════════════

describe('Prompt construction', () => {
  it('includes profile + catalogue + progress in prompt', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    expect(spy).toHaveBeenCalled();
    const body = JSON.parse(await spy.mock.calls[0][0].text());
    const prompt = body.messages[0].content;

    expect(prompt).toContain('python');
    expect(prompt).toContain('machine learning engineer');
    expect(prompt).toContain('Python Basics');
    expect(prompt).toContain('Completed courses');
    expect(prompt).toContain('In-progress');
    expect(prompt).toContain('prerequisites');
  });

  it('handles minimal profile gracefully', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);
    const spy = (env as any).AI_GATEWAY.fetch;
    spy.mockClear();

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: { skills: [], goals: "learn" },
      catalogue: TEST_CATALOGUE,
    });

    expect(spy).toHaveBeenCalled();
    const body = JSON.parse(await spy.mock.calls[0][0].text());
    expect(body.messages[0].content).toContain('none listed');
  });
});

// ════════════════════════════════════════════════════════
//  Observability Spans
// ════════════════════════════════════════════════════════

describe('Observability spans', () => {
  it('emits data.fetch span with catalogue + progress counts', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    expect(dataSpan).toBeDefined();
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.catalogue_courses).toBe(6);
    expect(parsed.progress_entries).toBe(2);
    expect(parsed.has_profile).toBe(true);
    expect(parsed.learner_id).toBe('l1');
    expect(parsed.org_id).toBe('org-test');
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits path.generate span with course count and why_this_fits count', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({
      response: JSON.stringify({
        courses: [
          { course_title: "Data Science Fundamentals", order: 1, why_this_fits: "Bridges skills to ML." },
          { course_title: "Machine Learning 101", order: 2, why_this_fits: "Your target domain." },
        ],
      }),
      model_used: "llama", provider: "cloudflare", tokens_used: 80, throttle_warning: false,
    });

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    const pathSpan = spanLogs.find((l) => l.includes('"span":"path.generate"'));
    expect(pathSpan).toBeDefined();
    const parsed = JSON.parse(pathSpan!);
    expect(parsed.ai_status).toBe('generated');
    expect(parsed.course_count).toBe(2);
    expect(parsed.why_this_fits_count).toBe(2);
    expect(parsed.prereq_violations).toBe(0);
    expect(parsed.llm_model).toBeTruthy();
    expect(parsed.llm_tokens).toBeGreaterThanOrEqual(0);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits path.generate span with prereq_violations when LLM orders wrong', async () => {
    // LLM returns ML 101 (needs DS Fundamentals) before DS Fundamentals
    (env as any).AI_GATEWAY = mockAiGateway({
      response: JSON.stringify({
        courses: [
          { course_title: "Machine Learning 101", order: 1, why_this_fits: "..." },
          { course_title: "Data Science Fundamentals", order: 2, why_this_fits: "..." },
        ],
      }),
      model_used: "llama", provider: "cloudflare", tokens_used: 50, throttle_warning: false,
    });

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: [],
    });

    const pathSpan = spanLogs.find((l) => l.includes('"span":"path.generate"'));
    expect(pathSpan).toBeDefined();
    const parsed = JSON.parse(pathSpan!);
    expect(parsed.prereq_violations).toBeGreaterThan(0);
    expect(parsed.ai_status).toBe('generated');
  });

  it('emits degraded path.generate span when gateway fails', async () => {
    (env as any).AI_GATEWAY = mockAiGateway({}, false);

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    const pathSpan = spanLogs.find((l) => l.includes('"span":"path.generate"'));
    expect(pathSpan).toBeDefined();
    const parsed = JSON.parse(pathSpan!);
    expect(parsed.ai_status).toBe('degraded');
    expect(parsed.ai_gateway_error).toBe(true);
    expect(parsed.course_count).toBe(0);
    expect(parsed.prereq_violations).toBe(0);
  });

  it('emits ai_gateway.generate sub-span', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      profile: TEST_PROFILE,
      catalogue: TEST_CATALOGUE,
      progress: TEST_PROGRESS,
    });

    const gwSpan = spanLogs.find((l) => l.includes('"span":"ai_gateway.generate"'));
    expect(gwSpan).toBeDefined();
    const parsed = JSON.parse(gwSpan!);
    expect(parsed.tier).toBe('standard');
    expect(parsed.status).toBe(200);
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits data.fetch span with insufficient_data flags when no profile', async () => {
    (env as any).AI_GATEWAY = mockAiGateway(DEFAULT_LLM_RESPONSE);

    await generate({
      learner_id: 'l1',
      org_id: 'org-test',
      catalogue: TEST_CATALOGUE,
    });

    const dataSpan = spanLogs.find((l) => l.includes('"span":"data.fetch"'));
    expect(dataSpan).toBeDefined();
    const parsed = JSON.parse(dataSpan!);
    expect(parsed.has_profile).toBe(false);
    expect(parsed.catalogue_courses).toBe(6);
  });
});
