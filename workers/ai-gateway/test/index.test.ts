import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../src/index';

// ──── Mock Workers AI ────
// Workers AI (`ai` binding) only runs on Cloudflare's edge, not locally.
// We inject a mock onto the test env so the Worker's logic can be tested.

function mockAiResponse(responseText = 'Hello! I am an AI assistant.') {
  return {
    response: responseText,
    usage: { total_tokens: 42, prompt_tokens: 10, completion_tokens: 32 },
  };
}

function mockEnvWithAi() {
  // The test wrangler.jsonc has no `ai` binding, so env.AI is undefined.
  // We attach a mock so the Worker can call env.AI.run().
  (env as any).AI = {
    run: vi.fn().mockResolvedValue(mockAiResponse()),
  };
}

// ──── Seed test data ────
beforeAll(async () => {
  // Vitest uses an isolated D1 — create the schema first
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS org_budgets (
      org_id TEXT PRIMARY KEY,
      monthly_token_cap INTEGER DEFAULT 1000000,
      tokens_used_this_period INTEGER DEFAULT 0,
      billing_period_start INTEGER
    )`
  ).run();

  await env.DB.prepare(
    `INSERT OR REPLACE INTO org_budgets (org_id, monthly_token_cap, tokens_used_this_period, billing_period_start)
     VALUES ('org-test', 100000, 0, 1751328000)`
  ).run();

  await env.DB.prepare(
    `INSERT OR REPLACE INTO org_budgets (org_id, monthly_token_cap, tokens_used_this_period, billing_period_start)
     VALUES ('org-broke', 10, 10, 1751328000)`
  ).run();

  mockEnvWithAi();
});

// ──── Cleanup ────
afterAll(async () => {
  await env.DB.prepare('DELETE FROM org_budgets WHERE org_id IN (?, ?)')
    .bind('org-test', 'org-broke')
    .run();
});

// ──── Helpers ────
function buildRequest(body: unknown): Request {
  return new Request('http://localhost/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callWorker(body: unknown) {
  const req = buildRequest(body);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════

describe('POST /generate — validation', () => {
  it('rejects GET requests', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/generate', { method: 'GET' }),
      env,
    );
    expect(res.status).toBe(405);
    const body: any = await res.json();
    expect(body.error).toBe('method_not_allowed');
  });

  it('rejects unknown paths', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/unknown', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('rejects empty body', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/generate', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing messages', async () => {
    const res = await callWorker({ tier: 'standard', org_id: 'org-test' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.field).toBe('messages');
  });

  it('rejects invalid tier', async () => {
    const res = await callWorker({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'premium',
      org_id: 'org-test',
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('invalid_tier');
  });

  it('rejects missing org_id', async () => {
    const res = await callWorker({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'standard',
    });
    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════
//  Budget enforcement
// ════════════════════════════════════════════════════

describe('POST /generate — budget enforcement', () => {
  it('rejects org with exhausted budget (429)', async () => {
    const res = await callWorker({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'standard',
      org_id: 'org-broke',
    });
    expect(res.status).toBe(429);
    const body: any = await res.json();
    expect(body.error).toBe('budget_exhausted');
  });

  it('allows org with remaining budget (bypasses 429)', async () => {
    const res = await callWorker({
      messages: [{ role: 'user', content: 'hi' }],
      tier: 'standard',
      org_id: 'org-test',
    });
    expect(res.status).not.toBe(429);
  });
});

// ════════════════════════════════════════════════════
//  Tier routing
// ════════════════════════════════════════════════════

describe('POST /generate — tier routing', () => {
  it('standard tier → llama-3.2-3b', async () => {
    (env as any).AI.run.mockResolvedValueOnce(mockAiResponse('standard output'));

    const res = await callWorker({
      messages: [{ role: 'user', content: 'Hello.' }],
      tier: 'standard',
      org_id: 'org-test',
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.model_used).toBe('@cf/meta/llama-3.2-3b-instruct');
    expect(body.provider).toBe('cloudflare');
    expect(body.response).toBe('standard output');
  });

  it('quality tier → mistral-7b', async () => {
    (env as any).AI.run.mockResolvedValueOnce(mockAiResponse('quality output'));

    const res = await callWorker({
      messages: [{ role: 'user', content: 'Hello.' }],
      tier: 'quality',
      org_id: 'org-test',
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.model_used).toBe('@cf/mistral/mistral-7b-instruct-v0.2-lora');
    expect(body.response).toBe('quality output');
  });
});

// ════════════════════════════════════════════════════
//  Token tracking
// ════════════════════════════════════════════════════

describe('POST /generate — token tracking', () => {
  it('returns token count in response', async () => {
    (env as any).AI.run.mockResolvedValueOnce(mockAiResponse('hi'));

    const res = await callWorker({
      messages: [{ role: 'user', content: 'Hi.' }],
      tier: 'standard',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.tokens_used).toBe(42);
  });

  it('increments tokens_used_this_period in D1', async () => {
    const before = await env.DB
      .prepare('SELECT tokens_used_this_period FROM org_budgets WHERE org_id = ?')
      .bind('org-test')
      .first<{ tokens_used_this_period: number }>();

    (env as any).AI.run.mockResolvedValueOnce(mockAiResponse('hello'));

    await callWorker({
      messages: [{ role: 'user', content: 'Hello.' }],
      tier: 'standard',
      org_id: 'org-test',
    });

    const after = await env.DB
      .prepare('SELECT tokens_used_this_period FROM org_budgets WHERE org_id = ?')
      .bind('org-test')
      .first<{ tokens_used_this_period: number }>();

    expect(after!.tokens_used_this_period).toBe((before!.tokens_used_this_period) + 42);
  });
});

// ════════════════════════════════════════════════════
//  Throttle warning
// ════════════════════════════════════════════════════

describe('POST /generate — throttle warning', () => {
  it('warns when near budget cap', async () => {
    await env.DB
      .prepare('UPDATE org_budgets SET tokens_used_this_period = 99980 WHERE org_id = ?')
      .bind('org-test')
      .run();

    (env as any).AI.run.mockResolvedValueOnce(mockAiResponse('story'));

    const res = await callWorker({
      messages: [{ role: 'user', content: 'Write a story.' }],
      tier: 'standard',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.throttle_warning).toBe(true);

    // Reset
    await env.DB
      .prepare('UPDATE org_budgets SET tokens_used_this_period = 0 WHERE org_id = ?')
      .bind('org-test')
      .run();
  });

  it('no warning when well under cap', async () => {
    (env as any).AI.run.mockResolvedValueOnce(mockAiResponse('short'));

    const res = await callWorker({
      messages: [{ role: 'user', content: 'Hi.' }],
      tier: 'standard',
      org_id: 'org-test',
    });

    const body: any = await res.json();
    expect(body.throttle_warning).toBe(false);
  });
});
