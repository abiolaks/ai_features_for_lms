// ============================================================
// AI08: Post-Quiz Insights
// ============================================================
// Generates personalized coaching insights after a learner
// completes a quiz. Fetches attempt details, assessment
// metadata, course progress, and lesson sections from LMS,
// builds a prompt, and calls AI03 Gateway.
// ============================================================

import { fetchLms } from '../../shared/fetch-lms';
import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan } from '../../shared/observability';
import { callGateway } from '../../shared/gateway';
import { parseLlmJson } from '../../shared/llm-parser';
import type { BaseEnv } from '../../shared/env';

export interface Env extends BaseEnv {}

// ──── Types ────

interface AttemptResponse {
  question_id: string;
  question_text: string;
  selected?: string;
  correct?: boolean;
  timeSpentSeconds?: number;
  correct_answer?: string;
}

interface AttemptData {
  id: string;
  userId: string;
  assessmentId: string;
  courseId: string | null;
  scorePercent: number;
  totalQuestions: number;
  correctAnswers: number;
  timeTakenSeconds: number | null;
  // Live LMS returns AttemptResponseResource objects; older fixtures
  // used JSON-encoded strings. normalizeResponse() handles both.
  responses: unknown[];
}

interface InsightRequest {
  attempt_id: string;
  learner_id: string;
  org_id: string;
}

interface MissedTopic {
  topic: string;
  review_link: string;
}

// Lesson summary from GET /api/v1/modules/{moduleId}/lessons
// (api.json: LessonResource — no `sections` field exists, so
// review links are lesson-level, never section-anchored)
interface LessonSummary {
  id: string;
  title: string;
  sortOrder: number;
}

interface InsightResponse {
  insight_text: string;
  missed_topics: MissedTopic[];
  tone_check: string;
  ai_status: string;
}

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'ai-insights' });
    }

    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (url.pathname !== '/insights/generate') {
      return json({ error: 'not_found' }, 404);
    }

    let body: { attempt_id?: string; learner_id?: string; org_id?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    if (!body.attempt_id) {
      return json({ error: 'missing_field: attempt_id' }, 400);
    }
    if (!body.learner_id) {
      return json({ error: 'missing_field: learner_id' }, 400);
    }
    if (!body.org_id) {
      return json({ error: 'missing_field: org_id' }, 400);
    }

    return handleGenerate(body as InsightRequest, env);
  },
};

// ════════════════════════════════════════════════════════
//  POST /insights/generate
// ════════════════════════════════════════════════════════

async function handleGenerate(
  body: InsightRequest,
  env: Env,
): Promise<Response> {
  // ── Validation (guaranteed by caller) ──

  // ═══════════════════════════════════════════════════════
  //  SPAN: data.fetch — gather all LMS data
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan('data.fetch');
  setAttr(dataSpan, 'attempt_id', body.attempt_id);
  setAttr(dataSpan, 'learner_id', body.learner_id);
  setAttr(dataSpan, 'org_id', body.org_id);

  // 1. Fetch attempt details
  let attemptData: AttemptData | null = null;
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/learner/assessments/attempts/${body.attempt_id}`,
    });
    if (resp.ok) {
      const raw = await resp.json() as any;
      attemptData = raw.data || raw;
      setAttr(dataSpan, 'score', attemptData!.scorePercent);
      setAttr(dataSpan, 'question_count', attemptData!.totalQuestions);
      setAttr(dataSpan, 'correct_count', attemptData!.correctAnswers);
    }
  } catch {
    setAttr(dataSpan, 'lms_attempt_error', true);
  }

  if (!attemptData) {
    setAttr(dataSpan, 'lms_unreachable', true);
    endSpan(dataSpan);
    return json(placeholderResponse(), 200);
  }

  // Normalize responses to extract per-question details + timing.
  // Live LMS shape (api.json AttemptResponseResource):
  //   { questionId, selectedOption, isCorrect, timeSpentSeconds,
  //     correctAnswer, question: { questionText, correctAnswer, ... } }
  const parsedResponses: AttemptResponse[] = [];
  for (const r of attemptData.responses || []) {
    const normalized = normalizeResponse(r);
    if (normalized) parsedResponses.push(normalized);
  }
  setAttr(dataSpan, 'responses_parsed', parsedResponses.length);

  // 2. Fetch assessment metadata
  // api.json: Assessment carries courseId AND moduleId — moduleId is
  // the bridge to real lesson IDs for review links.
  let assessmentTitle = 'Quiz';
  let courseId = attemptData.courseId || '';
  let moduleId = '';

  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/learner/assessments/${attemptData.assessmentId}`,
    });
    if (resp.ok) {
      const raw = await resp.json() as any;
      const data = raw.data || raw;
      assessmentTitle = data.title || 'Quiz';
      courseId = data.courseId || courseId;
      moduleId = data.moduleId || '';
    }
  } catch {
    // continue without assessment metadata
  }

  // 3. Fetch progress
  let progressPct = 0;
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/progress/user?userId=${body.learner_id}`,
    });
    if (resp.ok) {
      const raw = await resp.json() as any;
      const data = raw.data || raw;
      const enrollments = data.enrollments || [];
      // Find enrollment matching the assessment's course
      for (const e of enrollments) {
        if (courseId && e.courseId === courseId) {
          progressPct = parseInt(e.progressPercent) || 0;
          break;
        }
      }
      // If no exact match, use the first enrollment with progress
      if (progressPct === 0 && enrollments.length > 0) {
        progressPct = parseInt(enrollments[0].progressPercent) || 0;
      }
    }
  } catch {
    // continue without progress
  }

  setAttr(dataSpan, 'progress_pct', progressPct);

  // 4. Fetch module lessons for review links
  // api.json: GET /v1/modules/{moduleId}/lessons → { data: LessonResource[] }
  // (no `success` flag on this wrapper). Lesson IDs sourced from this
  // listing are valid by construction — no 404s possible.
  let moduleLessons: LessonSummary[] = [];
  if (moduleId) {
    try {
      const resp = await fetchLms(env, {
        path: `/api/v1/modules/${moduleId}/lessons`,
      });
      if (resp.ok) {
        const raw = await resp.json() as any;
        // LessonResource can degenerate to an empty array — guard for objects
        const items = Array.isArray(raw.data) ? raw.data : [];
        const quizTitle = assessmentTitle.trim().toLowerCase();
        moduleLessons = items
          .filter((l: any) => l && typeof l === 'object' && l.id && l.title)
          // Exclude the quiz's own lesson — a quiz is never its own review target
          .filter((l: any) => String(l.title).trim().toLowerCase() !== quizTitle)
          .map((l: any) => ({
            id: String(l.id),
            title: String(l.title),
            sortOrder: Number(l.sortOrder) || 0,
          }))
          .sort((a: LessonSummary, b: LessonSummary) => a.sortOrder - b.sortOrder);
      }
    } catch {
      // continue without module lessons — review links will be empty
    }
  }

  // 5. Build review links by matching missed-question topics to real
  // lesson titles. Lesson-level links only — LessonResource exposes no
  // sections, so section anchors are deferred until the LMS adds them.
  const missedQuestions = parsedResponses.filter((r) => r.correct === false);
  const reviewLinks: MissedTopic[] = [];
  let matchedCount = 0;
  let fallbackUsed = false;

  if (courseId && moduleLessons.length > 0) {
    for (const q of missedQuestions.slice(0, 3)) {
      const topic = extractTopic(q.question_text);
      const match = matchLessonForTopic(topic, moduleLessons);
      if (match) {
        matchedCount++;
        reviewLinks.push({
          topic,
          review_link: `/courses/${courseId}/lessons/${match.id}`,
        });
      } else {
        // Fallback: first lesson in the module — still a valid URL
        fallbackUsed = true;
        reviewLinks.push({
          topic,
          review_link: `/courses/${courseId}/lessons/${moduleLessons[0].id}`,
        });
      }
    }
  }

  setAttr(dataSpan, 'missed_questions', missedQuestions.length);
  setAttr(dataSpan, 'has_review_links', reviewLinks.length > 0);
  setAttr(dataSpan, 'review_links_source', moduleLessons.length > 0 ? 'module_listing' : 'none');
  setAttr(dataSpan, 'review_links_validated', moduleLessons.length > 0);
  setAttr(dataSpan, 'review_links_matched', matchedCount);
  setAttr(dataSpan, 'review_links_fallback_used', fallbackUsed);
  endSpan(dataSpan);

  // ═══════════════════════════════════════════════════════
  //  Build the insight prompt
  // ═══════════════════════════════════════════════════════
  const prompt = buildPrompt(
    attemptData.scorePercent,
    attemptData.correctAnswers,
    attemptData.totalQuestions,
    parsedResponses,
    progressPct,
    assessmentTitle,
  );

  // ═══════════════════════════════════════════════════════
  //  SPAN: insight.generate — LLM call + parsing
  // ═══════════════════════════════════════════════════════
  const insightSpan = startSpan('insight.generate');
  setAttr(insightSpan, 'org_id', body.org_id);
  setAttr(insightSpan, 'score', attemptData.scorePercent);
  setAttr(insightSpan, 'missed_topic_candidates', missedQuestions.length);

  try {
    // ── Call AI03 Gateway ──
    const gwSpan = startSpan('ai_gateway.generate');
    setAttr(gwSpan, 'tier', 'standard');

    const result = await callGateway(env.AI_GATEWAY, prompt, body.org_id);

    setAttr(gwSpan, 'status', result ? 200 : 502);
    endSpan(gwSpan);

    if (!result) {
      setAttr(insightSpan, 'ai_gateway_error', true);
      setAttr(insightSpan, 'ai_status', 'degraded');
      setAttr(insightSpan, 'tone_encouraging', true);
      endSpan(insightSpan);
      return json(placeholderResponse(), 200);
    }

    setAttr(insightSpan, 'llm_model', result.model);
    setAttr(insightSpan, 'llm_tokens', result.tokens);

    // Parse LLM response
    const responseText: string = result.text;

    const parsed = parseInsight(responseText, reviewLinks, insightSpan, moduleLessons, courseId);

    setAttr(insightSpan, 'ai_status', 'generated');
    setAttr(insightSpan, 'tone_encouraging', true);
    setAttr(insightSpan, 'missed_topics_count', parsed.missed_topics.length);
    endSpan(insightSpan);

    return json(parsed, 200);
  } catch (err: any) {
    setAttr(insightSpan, 'ai_gateway_error', true);
    setAttr(insightSpan, 'ai_status', 'degraded');
    setAttr(insightSpan, 'tone_encouraging', true);
    setAttr(insightSpan, 'error', err.message);
    endSpan(insightSpan);
    return json(placeholderResponse(), 200);
  }
}

// ════════════════════════════════════════════════════════
//  Response Normalizer
// ════════════════════════════════════════════════════════

/**
 * Normalize a single attempt response into the internal shape.
 * Accepts the live LMS object (camelCase, nested `question`) or a
 * JSON-encoded string (legacy fixtures). Returns null if unusable.
 */
function normalizeResponse(raw: unknown): AttemptResponse | null {
  let r: any = raw;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== 'object') return null;

  const question = r.question && typeof r.question === 'object' ? r.question : {};
  const questionText = r.question_text ?? question.questionText ?? '';
  const correct = r.correct ?? r.isCorrect;

  return {
    question_id: r.question_id ?? r.questionId ?? question.id ?? '',
    question_text: String(questionText),
    selected: r.selected ?? r.selectedOption,
    correct: typeof correct === 'boolean' ? correct : undefined,
    timeSpentSeconds:
      typeof r.timeSpentSeconds === 'number' ? r.timeSpentSeconds : undefined,
    correct_answer: r.correct_answer ?? r.correctAnswer ?? question.correctAnswer,
  };
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildPrompt(
  score: number,
  correct: number,
  total: number,
  responses: AttemptResponse[],
  progressPct: number,
  title: string,
): string {
  // Build timing breakdown
  const timingLines = responses
    .filter((r) => r.timeSpentSeconds !== undefined)
    .map((r) => {
      const time = r.timeSpentSeconds!;
      const marker = time > 60 ? ' (significantly longer)' : '';
      const status = r.correct ? 'correct' : 'incorrect';
      return `  - "${r.question_text}": ${time}s [${status}]${marker}`;
    })
    .join('\n');

  // Build missed questions detail
  const missedQuestions = responses.filter((r) => r.correct === false && r.question_text);
  const missedLines = missedQuestions
    .map((r) => `  - "${r.question_text}" (correct answer: ${r.correct_answer || 'unknown'})`)
    .join('\n');

  return [
    `You are a supportive learning coach. Generate a brief, encouraging post-quiz insight.`,
    ``,
    `QUIZ: ${title}`,
    `Score: ${score}% (${correct} correct out of ${total} questions)`,
    ``,
    `CURRENT COURSE PROGRESS: ${progressPct}% complete`,
    ``,
    `TIME SPENT PER QUESTION:`,
    timingLines || '  (no timing data available)',
    ``,
    `MISSED QUESTIONS:`,
    missedLines || '  (none — perfect score!)',
    ``,
    `RULES (follow strictly):`,
    `1. Start with something positive, even if the score is low.`,
    `2. Identify 1-2 specific topics to review based on missed questions.`,
    `3. If they spent significantly longer (>60s) on any question, mention it as a review area.`,
    `4. Reference their course progress positively ("65% through — keep it up!").`,
    `5. NEVER use negative, shaming, sarcastic, or discouraging language.`,
    `6. Be warm, personal, and specific.`,
    ``,
    `Return a JSON object. No other text.`,
    `Format: {"insight":"<encouraging paragraph>","missed_topics":["Topic 1","Topic 2"]}`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

function parseInsight(
  response: string,
  reviewLinks: MissedTopic[],
  insightSpan: SpanContext,
  lessons: LessonSummary[] = [],
  courseId = '',
): InsightResponse {
  const parsed = parseLlmJson<{ insight?: string; response?: string; insight_text?: string; missed_topics?: string[]; topics?: string[] }>(response);

  if (!parsed) {
    setAttr(insightSpan, 'parse_failed', response.includes('{') ? 'json_error' : 'no_json');
    return {
      insight_text: response.slice(0, 500) || 'Insights unavailable right now — check back shortly.',
      missed_topics: [],
      tone_check: 'encouraging',
      ai_status: 'degraded',
    };
  }

  const insightText = parsed.insight || parsed.response || parsed.insight_text || '';
  const topicNames: string[] = parsed.missed_topics || parsed.topics || [];

  // Map LLM topic names to review links. Prefer a direct match against
  // lesson titles (the LLM often names topics after lesson content),
  // then fall back to overlap with question-derived topics, then index.
  const missedTopics: MissedTopic[] = topicNames.map((name: string, i: number) => {
    if (courseId && lessons.length > 0) {
      const direct = matchLessonForTopic(name, lessons);
      if (direct) {
        return { topic: name, review_link: `/courses/${courseId}/lessons/${direct.id}` };
      }
    }
    const nameTokens = tokenize(name);
    let best: MissedTopic | null = null;
    let bestScore = 0;
    for (const l of reviewLinks) {
      const score = overlapScore(nameTokens, tokenize(l.topic));
      if (score > bestScore) {
        bestScore = score;
        best = l;
      }
    }
    if (best) return { topic: name, review_link: best.review_link };
    // Fallback: use review link by index
    if (i < reviewLinks.length) {
      return { topic: name, review_link: reviewLinks[i].review_link };
    }
    return { topic: name, review_link: '' };
  });

  return {
    insight_text: insightText || 'Great effort! Keep up the good work.',
    missed_topics: missedTopics,
    tone_check: 'encouraging',
    ai_status: 'generated',
  };
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function extractTopic(questionText: string): string {
  // Extract a short topic from a question — take first 50 chars, strip common prefixes
  const cleaned = questionText
    .replace(/^(what is|explain|describe|how does|define|what are)\s+/i, '')
    .replace(/[?]/g, '')
    .trim();
  return cleaned.length > 50 ? cleaned.slice(0, 50) + '...' : cleaned;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on',
  'for', 'and', 'or', 'what', 'how', 'why', 'when', 'which', 'does', 'do',
  'it', 'this', 'that', 'with', 'you', 'your', 'can', 'will', 'not',
]);

/** Tokenize into lowercase words, dropping stopwords and naive plurals. */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    tokens.add(raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return tokens;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let score = 0;
  for (const t of a) if (b.has(t)) score++;
  return score;
}

/** Match a missed-question topic to the best lesson in the module by title overlap. */
function matchLessonForTopic(
  topic: string,
  lessons: LessonSummary[],
): LessonSummary | null {
  const topicTokens = tokenize(topic);
  let best: LessonSummary | null = null;
  let bestScore = 0;
  for (const lesson of lessons) {
    const score = overlapScore(topicTokens, tokenize(lesson.title));
    if (score > bestScore) {
      bestScore = score;
      best = lesson;
    }
  }
  return best;
}

function placeholderResponse(): InsightResponse {
  return {
    insight_text: 'Insights unavailable right now — check back shortly.',
    missed_topics: [],
    tone_check: 'encouraging',
    ai_status: 'degraded',
  };
}
