// ============================================================
// F07: Question Generation
// ============================================================
// POST /questions/generate
//
// Auto-generates quiz questions from lesson content. Works with
// text, PDF, and video (via transcript chunks from Vectorize).
// Uses quality-tier LLM for richer question generation.
// ============================================================

import { fetchLms } from '../../shared/fetch-lms';
import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan } from '../../shared/observability';
import { callGateway } from '../../shared/gateway';
import { parseLlmJson } from '../../shared/llm-parser';
import type { BaseEnv } from '../../shared/env';

/** Worker bindings — exposed via wrangler.jsonc */
interface Env extends BaseEnv {
  VECTORIZE_INDEX: VectorizeIndex;
  AI: Ai;
}

// ──── LMS Response Types ────

interface LessonData {
  id: string;
  title: string;
  content: string;
  courseId?: string;
  moduleId?: string;
}

interface LessonResponse {
  data: LessonData;
}

// ──── Request / Response Types ────

interface GenerateRequest {
  lesson_id: string;
  org_id: string;
  count?: number;
  type?: 'multiple-choice' | 'true-false';
}

interface Question {
  text: string;
  options: string[];
  correct_answer: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  topic: string;
}

interface GenerateResponse {
  lesson_id: string;
  lesson_title: string;
  questions: Question[];
  content_source: 'lms' | 'vectorize';
  content_length_chars: number;
  ai_status: string;
  generated_at: string;
}

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

// ════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════

const EMBEDDING_MODEL = '@cf/baai/bge-large-en-v1.5';
const QUALITY_TIER = 'quality';
const MAX_VECTORIZE_RESULTS = 50;
const MIN_CONTENT_LENGTH = 200;
const DEFAULT_QUESTION_COUNT = 5;
const MAX_QUESTION_COUNT = 15;

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'ai-question-gen' });
    }

    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/questions/generate') {
      let body: GenerateRequest;
      try {
        body = (await req.json()) as GenerateRequest;
      } catch {
        return json({ error: 'invalid_json_body' }, 400);
      }

      if (!body.lesson_id) {
        return json({ error: 'missing_field: lesson_id' }, 400);
      }
      if (!body.org_id) {
        return json({ error: 'missing_field: org_id' }, 400);
      }

      const count = Math.min(
        Math.max(body.count ?? DEFAULT_QUESTION_COUNT, 1),
        MAX_QUESTION_COUNT,
      );
      const qType = body.type === 'true-false' ? 'true-false' : 'multiple-choice';

      return handleGenerate(body.lesson_id, body.org_id, count, qType, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  POST /questions/generate
// ════════════════════════════════════════════════════════

async function handleGenerate(
  lessonId: string,
  orgId: string,
  count: number,
  qType: 'multiple-choice' | 'true-false',
  env: Env,
): Promise<Response> {
  // ═══════════════════════════════════════════════════════
  //  SPAN: data.fetch — gather lesson content
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan('data.fetch');
  setAttr(dataSpan, 'lesson_id', lessonId);
  setAttr(dataSpan, 'org_id', orgId);

  // ── 1. Fetch lesson from LMS ──
  let lessonTitle = '';
  let content = '';
  let contentSource: 'lms' | 'vectorize' = 'lms';

  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/lessons/${encodeURIComponent(lessonId)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const lesson: LessonData = raw.data || raw;
      lessonTitle = lesson.title || '';
      content = (lesson.content || '').trim();
    }
  } catch {
    setAttr(dataSpan, 'lms_unreachable', true);
  }

  setAttr(dataSpan, 'lms_ok', content.length > 0);

  // ── 2. If content is too short/empty, fall back to Vectorize transcript ──
  if (content.length < MIN_CONTENT_LENGTH) {
    try {
      const vectorContent = await fetchTranscriptChunks(lessonId, env);
      if (vectorContent.length >= MIN_CONTENT_LENGTH) {
        content = vectorContent;
        contentSource = 'vectorize';
        setAttr(dataSpan, 'vectorize_fallback', true);
      }
    } catch {
      setAttr(dataSpan, 'vectorize_unavailable', true);
    }
  }

  const contentLength = content.length;
  setAttr(dataSpan, 'content_length', contentLength);
  setAttr(dataSpan, 'content_source', contentSource);
  endSpan(dataSpan);

  // ── 3. Content insufficient ──
  if (content.length < MIN_CONTENT_LENGTH) {
    return json({
      lesson_id: lessonId,
      lesson_title: lessonTitle,
      questions: [],
      content_source: contentSource,
      content_length_chars: contentLength,
      ai_status: 'insufficient_content',
      generated_at: new Date().toISOString(),
    }, 200);
  }

  // ═══════════════════════════════════════════════════════
  //  Build prompt, call AI03 Gateway (quality tier)
  // ═══════════════════════════════════════════════════════
  const prompt = buildQuestionPrompt(lessonTitle, content, count, qType);

  const insightSpan = startSpan('insight.generate');
  setAttr(insightSpan, 'lesson_id', lessonId);
  setAttr(insightSpan, 'question_count', count);
  setAttr(insightSpan, 'question_type', qType);
  setAttr(insightSpan, 'content_chars', contentLength);

  try {
    const gwSpan = startSpan('ai_gateway.generate');
    setAttr(gwSpan, 'tier', QUALITY_TIER);

    const result = await callGateway(env.AI_GATEWAY, prompt, orgId, QUALITY_TIER);

    setAttr(gwSpan, 'status', result ? 200 : 502);
    endSpan(gwSpan);

    if (!result) {
      setAttr(insightSpan, 'ai_gateway_error', true);
      setAttr(insightSpan, 'ai_status', 'degraded');
      endSpan(insightSpan);
      return json(degradedResponse(lessonId, lessonTitle, contentSource, contentLength), 200);
    }

    setAttr(insightSpan, 'llm_model', result.model);
    setAttr(insightSpan, 'llm_tokens', result.tokens);

    const { questions, parsed } = parseQuestions(result.text, count);

    const aiStatus = parsed ? 'generated' : 'degraded';
    setAttr(insightSpan, 'ai_status', aiStatus);
    setAttr(insightSpan, 'generated_count', questions.length);
    setAttr(insightSpan, 'parse_failed', !parsed);
    endSpan(insightSpan);

    return json({
      lesson_id: lessonId,
      lesson_title: lessonTitle,
      questions,
      content_source: contentSource,
      content_length_chars: contentLength,
      ai_status: aiStatus,
      generated_at: new Date().toISOString(),
    }, 200);
  } catch (err: any) {
    setAttr(insightSpan, 'ai_gateway_error', true);
    setAttr(insightSpan, 'ai_status', 'degraded');
    setAttr(insightSpan, 'error', err.message);
    endSpan(insightSpan);
    return json(degradedResponse(lessonId, lessonTitle, contentSource, contentLength), 200);
  }
}

// ════════════════════════════════════════════════════════
//  Transcript Retrieval (Vectorize)
// ════════════════════════════════════════════════════════

async function fetchTranscriptChunks(
  lessonId: string,
  env: Env,
): Promise<string> {
  // Query Vectorize with a neutral embedding + lesson_id filter
  const embedding = await env.AI.run(EMBEDDING_MODEL, {
    text: 'lesson transcript content',
  });
  const vector: number[] = Array.isArray(embedding)
    ? embedding
    : (embedding as any).data?.[0] ?? embedding;

  const results = await env.VECTORIZE_INDEX.query(vector, {
    topK: MAX_VECTORIZE_RESULTS,
    returnMetadata: true,
    filter: { lesson_id: lessonId },
  });

  const matches = (results.matches || []) as VectorizeMatch[];

  // Sort by chunk_index, assemble in order
  const sorted = matches
    .filter((m) => m.metadata?.content)
    .sort((a, b) => {
      const ai = a.metadata?.chunk_index ?? 0;
      const bi = b.metadata?.chunk_index ?? 0;
      return ai - bi;
    });

  return sorted.map((m) => m.metadata!.content).join('\n\n');
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildQuestionPrompt(
  title: string,
  content: string,
  count: number,
  qType: 'multiple-choice' | 'true-false',
): string {
  // Truncate content if extremely long (avoid token overflow)
  const maxChars = 12000;
  const truncated = content.length > maxChars
    ? content.slice(0, maxChars) + '\n\n[...content truncated for length...]'
    : content;

  const typeInstructions = qType === 'true-false'
    ? `Generate ${count} true/false questions. Each must have exactly 2 options: "True" and "False".`
    : `Generate ${count} multiple-choice questions. Each must have exactly 4 options (1 correct answer + 3 plausible but clearly wrong distractors).`;

  return [
    `You are an expert quiz creator. Generate questions from the lesson content below.`,
    ``,
    `LESSON TITLE: ${title}`,
    ``,
    `LESSON CONTENT:`,
    truncated,
    ``,
    `INSTRUCTIONS:`,
    typeInstructions,
    `- Every question must be answerable from the content alone — no outside knowledge.`,
    `- Assign a difficulty: "beginner" (simple recall), "intermediate" (understanding/applying), or "advanced" (analysis/synthesis).`,
    `- Assign a topic tag — a short phrase describing the concept tested (e.g., "Variables", "Loops", "Functions").`,
    `- The correct_answer must exactly match one of the options.`,
    ``,
    `Return a JSON array. No other text.`,
    `Format: [{"text":"...","options":["...","...",...],"correct_answer":"...","difficulty":"beginner|intermediate|advanced","topic":"..."}]`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

interface LlmQuestion {
  text?: string;
  options?: string[];
  correct_answer?: string;
  difficulty?: string;
  topic?: string;
}

function parseQuestions(
  response: string,
  expectedCount: number,
): { questions: Question[]; parsed: boolean } {
  const parsed = parseLlmJson<LlmQuestion[]>(response);

  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    return { questions: [], parsed: false };
  }

  const validDifficulty = (d: string | undefined): Question['difficulty'] => {
    if (d === 'beginner' || d === 'intermediate' || d === 'advanced') return d;
    return 'intermediate';
  };

  const questions: Question[] = [];

  for (const item of parsed) {
    const text = sanitize(item.text);
    if (!text) continue;

    const options = (item.options || []).map(sanitize).filter((s) => s.length > 0);
    if (options.length < 2) continue;

    const correct = sanitize(item.correct_answer);
    if (!correct) continue;

    // Validate correct_answer is in options
    if (!options.includes(correct)) continue;

    questions.push({
      text,
      options,
      correct_answer: correct,
      difficulty: validDifficulty(item.difficulty),
      topic: sanitize(item.topic) || 'General',
    });
  }

  return {
    questions: questions.slice(0, expectedCount),
    parsed: questions.length > 0,
  };
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function sanitize(text: string | undefined): string {
  if (!text) return '';
  return text.replace(/^["']+|["']+$/g, '').trim().slice(0, 500);
}

// ════════════════════════════════════════════════════════
//  Response Builders
// ════════════════════════════════════════════════════════

function degradedResponse(
  lessonId: string,
  lessonTitle: string,
  contentSource: 'lms' | 'vectorize',
  contentLength: number,
): GenerateResponse {
  return {
    lesson_id: lessonId,
    lesson_title: lessonTitle,
    questions: [],
    content_source: contentSource,
    content_length_chars: contentLength,
    ai_status: 'degraded',
    generated_at: new Date().toISOString(),
  };
}
