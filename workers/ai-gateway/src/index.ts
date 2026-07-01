import type { GenerateRequest, GenerateResponse } from '../../shared/types';

// ──── Model map — use the actual available models on this account ────
const MODELS = {
  standard: '@cf/meta/llama-3.2-3b-instruct',
  quality: '@cf/mistral/mistral-7b-instruct-v0.2-lora',
} as const;

// ──── Environment bindings ────
export interface Env {
  AI: Ai;
  DB: D1Database;
  LMS_CACHE: KVNamespace;
}

// ──── Budget row shape ────
interface BudgetRow {
  org_id: string;
  monthly_token_cap: number;
  tokens_used_this_period: number;
  billing_period_start: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    const url = new URL(req.url);
    if (url.pathname !== '/generate') {
      return json({ error: 'not_found' }, 404);
    }

    let body: GenerateRequest;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    // Validate
    if (!body.messages?.length) {
      return json({ error: 'missing_field', field: 'messages' }, 400);
    }
    if (!body.tier || !['standard', 'quality'].includes(body.tier)) {
      return json({ error: 'invalid_tier', valid: ['standard', 'quality'] }, 400);
    }
    if (!body.org_id) {
      return json({ error: 'missing_field', field: 'org_id' }, 400);
    }

    // ── 1. Budget check ──
    const budget = await getBudget(env.DB, body.org_id);
    const exhausted = budget && budget.tokens_used_this_period >= budget.monthly_token_cap;

    if (exhausted) {
      return json(
        {
          error: 'budget_exhausted',
          message: 'Contact your org admin to increase the budget.',
        },
        429,
      );
    }

    // ── 2. Call Workers AI ──
    const model = MODELS[body.tier];
    const maxTokens = body.tier === 'quality' ? 2048 : 1024;

    let aiResult: AiTextGenerationOutput;
    try {
      aiResult = (await env.AI.run(model, {
        messages: body.messages,
        max_tokens: maxTokens,
      })) as AiTextGenerationOutput;
    } catch (err) {
      console.error('Workers AI error:', err);
      return json({ error: 'ai_call_failed', detail: String(err) }, 502);
    }

    // ── 3. Track tokens ──
    const tokensUsed = aiResult.usage?.total_tokens ?? 0;
    const throttle = budget
      ? budget.tokens_used_this_period + tokensUsed >= budget.monthly_token_cap
      : false;

    await trackTokens(env.DB, body.org_id, tokensUsed);

    // ── 4. Return ──
    const response: GenerateResponse = {
      response: aiResult.response ?? '',
      model_used: model,
      provider: 'cloudflare',
      tokens_used: tokensUsed,
      throttle_warning: throttle,
    };

    return json(response, 200);
  },
};

// ──── Helpers ────

async function getBudget(db: D1Database, orgId: string): Promise<BudgetRow | null> {
  const result = await db
    .prepare('SELECT * FROM org_budgets WHERE org_id = ?')
    .bind(orgId)
    .first<BudgetRow>();
  return result ?? null;
}

async function trackTokens(db: D1Database, orgId: string, tokens: number): Promise<void> {
  await db
    .prepare(
      'UPDATE org_budgets SET tokens_used_this_period = tokens_used_this_period + ? WHERE org_id = ?',
    )
    .bind(tokens, orgId)
    .run();
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
