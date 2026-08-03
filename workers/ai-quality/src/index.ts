// ============================================================
// F08: Quality Checks
// ============================================================
// POST /questions/validate
//
// Validates AI-generated quiz questions against source content.
// Checks: accuracy, distractor quality, clarity, difficulty
// alignment, and bias. Returns pass/fail per question with
// actionable suggestions. Uses standard-tier LLM.
// ============================================================

import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan } from '../../shared/observability';
import { callGateway } from '../../shared/gateway';
import { parseLlmJson } from '../../shared/llm-parser';
import type { BaseEnv } from '../../shared/env';

interface Env extends BaseEnv {}

// ──── Types ────

interface QuestionInput {
  text: string;
  options: string[];
  correct_answer: string;
  difficulty: string;
  topic: string;
  source_content: string;
}

interface ValidationRequest {
  questions: QuestionInput[];
}

interface ValidationResult {
  question_index: number;
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

interface ValidationResponse {
  total: number;
  passed: number;
  failed: number;
  results: ValidationResult[];
  ai_status: string;
  generated_at: string;
}

// ──── LLM Response Types ────

interface LlmValidationItem {
  passed?: boolean;
  issues?: string[];
  suggestions?: string[];
}

// ════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════

const STANDARD_TIER = 'standard';
const MAX_BATCH_SIZE = 20;
const MAX_SOURCE_LENGTH = 5000; // truncate per-question source

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'ai-quality' });
    }

    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/questions/validate') {
      let body: ValidationRequest;
      try {
        body = (await req.json()) as ValidationRequest;
      } catch {
        return json({ error: 'invalid_json_body' }, 400);
      }

      if (!body.questions || !Array.isArray(body.questions)) {
        return json({ error: 'missing_field: questions' }, 400);
      }

      if (body.questions.length === 0) {
        return json({ error: 'empty_questions_array' }, 400);
      }

      if (body.questions.length > MAX_BATCH_SIZE) {
        return json({
          error: `batch_too_large: max ${MAX_BATCH_SIZE} questions per request`,
        }, 400);
      }

      return handleValidate(body.questions, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  POST /questions/validate
// ════════════════════════════════════════════════════════

async function handleValidate(
  questions: QuestionInput[],
  env: Env,
): Promise<Response> {
  const insightSpan = startSpan('insight.generate');
  setAttr(insightSpan, 'question_count', questions.length);

  // Validate each question via AI03
  const results: ValidationResult[] = [];
  let gatewayFailures = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    // Skip questions with missing critical fields
    if (!q.text || !q.source_content || !q.correct_answer || !q.options) {
      results.push({
        question_index: i,
        passed: false,
        issues: ['Missing required fields (text, source_content, correct_answer, or options)'],
        suggestions: ['Provide all required fields before validation.'],
      });
      continue;
    }

    const prompt = buildValidationPrompt(q, i);

    try {
      const gwSpan = startSpan('ai_gateway.generate');
      setAttr(gwSpan, 'tier', STANDARD_TIER);
      setAttr(gwSpan, 'question_index', i);

      const result = await callGateway(env.AI_GATEWAY, prompt, '', STANDARD_TIER);

      if (!result) {
        setAttr(gwSpan, 'status', 502);
        endSpan(gwSpan);
        gatewayFailures++;
        results.push(skeletonResult(i, 'Gateway unavailable'));
        continue;
      }

      setAttr(gwSpan, 'status', 200);
      setAttr(gwSpan, 'llm_model', result.model);
      endSpan(gwSpan);

      const parsed = parseValidationResult(result.text, i);
      results.push(parsed);
    } catch (err: any) {
      gatewayFailures++;
      results.push(skeletonResult(i, `Gateway error: ${err.message}`));
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  const aiStatus = gatewayFailures > 0
    ? (gatewayFailures === questions.length ? 'degraded' : 'partial')
    : 'generated';

  setAttr(insightSpan, 'ai_status', aiStatus);
  setAttr(insightSpan, 'total', questions.length);
  setAttr(insightSpan, 'passed', passed);
  setAttr(insightSpan, 'failed', failed);
  setAttr(insightSpan, 'gateway_failures', gatewayFailures);
  endSpan(insightSpan);

  return json({
    total: questions.length,
    passed,
    failed,
    results,
    ai_status: aiStatus,
    generated_at: new Date().toISOString(),
  }, 200);
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildValidationPrompt(q: QuestionInput, index: number): string {
  const source = q.source_content.length > MAX_SOURCE_LENGTH
    ? q.source_content.slice(0, MAX_SOURCE_LENGTH) + '\n[...truncated...]'
    : q.source_content;

  const optionsText = q.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n');

  return [
    `You are a quiz quality reviewer. Evaluate this question against the source content.`,
    ``,
    `SOURCE CONTENT:`,
    source,
    ``,
    `QUESTION (index ${index}):`,
    `  Text: ${q.text}`,
    `  Options:`,
    optionsText,
    `  Correct answer: ${q.correct_answer}`,
    `  Assigned difficulty: ${q.difficulty}`,
    `  Topic: ${q.topic}`,
    ``,
    `CHECK THESE DIMENSIONS:`,
    `1. ACCURACY — Is the correct answer verifiable from the source? If not, flag as hallucinated.`,
    `2. DISTRACTOR QUALITY — Are wrong answers genuinely wrong (not ambiguous) when checked against the source?`,
    `3. CLARITY — Is the question wording clear and unambiguous?`,
    `4. DIFFICULTY ALIGNMENT — Does the assigned difficulty match the content complexity? (beginner=simple recall, intermediate=understanding, advanced=analysis)`,
    `5. BIAS — Are there demographic assumptions or cultural references that could disadvantage learners?`,
    ``,
    `Return a JSON object. No other text.`,
    `Format: {"passed":true|false,"issues":["...","..."],"suggestions":["...","..."]}`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

function parseValidationResult(
  response: string,
  index: number,
): ValidationResult {
  const parsed = parseLlmJson<LlmValidationItem>(response);

  if (!parsed) {
    return skeletonResult(index, 'Could not parse LLM response');
  }

  return {
    question_index: index,
    passed: parsed.passed !== false, // default to true if missing (optimistic)
    issues: sanitizeArray(parsed.issues),
    suggestions: sanitizeArray(parsed.suggestions),
  };
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function sanitizeArray(arr: string[] | undefined): string[] {
  if (!arr || !Array.isArray(arr)) return [];
  return arr
    .map((s) => (typeof s === 'string' ? s.trim().slice(0, 300) : ''))
    .filter((s) => s.length > 0);
}

/** Build a skeleton result when the gateway or parsing fails. */
function skeletonResult(index: number, reason: string): ValidationResult {
  return {
    question_index: index,
    passed: false,
    issues: [reason],
    suggestions: ['Retry validation or manually review this question.'],
  };
}
