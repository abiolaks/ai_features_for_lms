// ============================================================
// AI08: Post-Quiz Insights + F03b: Session Prep Insights
// ============================================================
// POST /insights/generate — Personalized coaching after quiz
// POST /mentor/session-prep — Mentor session agenda from
//   learner activity, quiz scores, and stalled modules.
// ============================================================

import { fetchLms } from '../../shared/fetch-lms';
import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan, type SpanContext } from '../../shared/observability';
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

// ──── F03b: Session Prep Types ────

interface SessionPrepRequest {
  learner_id: string;
  mentor_id: string;
  org_id: string;
}

interface AgendaItem {
  topic: string;
  reason: string;
  duration_min: number;
}

interface PrepMaterial {
  lesson_title: string;
  link: string;
}

interface SessionPrepResponse {
  recent_activity: {
    completed_lessons: number;
    quiz_scores: { avg: number; lowest_topic: string };
    stalled_modules: string[];
  };
  suggested_agenda: AgendaItem[];
  prep_materials: PrepMaterial[];
  ai_status: string;
}

interface EnrollmentSummary {
  id: string;
  title: string;
  status: string;
  progressPercent: number;
  courseId: string;
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

    if (url.pathname === '/insights/generate') {
      return handleInsightsRoute(req, env);
    }

    if (url.pathname === '/mentor/session-prep') {
      return handleSessionPrepRoute(req, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  Route Handlers
// ════════════════════════════════════════════════════════

async function handleInsightsRoute(req: Request, env: Env): Promise<Response> {
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
}

async function handleSessionPrepRoute(req: Request, env: Env): Promise<Response> {
  let body: { learner_id?: string; mentor_id?: string; org_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!body.learner_id) {
    return json({ error: 'missing_field: learner_id' }, 400);
  }
  if (!body.mentor_id) {
    return json({ error: 'missing_field: mentor_id' }, 400);
  }
  if (!body.org_id) {
    return json({ error: 'missing_field: org_id' }, 400);
  }

  return handleSessionPrep(body as SessionPrepRequest, env);
}

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

// ════════════════════════════════════════════════════════
//  POST /mentor/session-prep (F03b)
// ════════════════════════════════════════════════════════

async function handleSessionPrep(
  body: SessionPrepRequest,
  env: Env,
): Promise<Response> {
  // ═══════════════════════════════════════════════════════
  //  SPAN: session_prep.data_fetch — gather all LMS data
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan('session_prep.data_fetch');
  setAttr(dataSpan, 'learner_id', body.learner_id);
  setAttr(dataSpan, 'mentor_id', body.mentor_id);
  setAttr(dataSpan, 'org_id', body.org_id);

  // 1. Fetch learner profile
  let learnerName = '';
  let learnerSkills: string[] = [];
  let learnerGoals = '';
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/learner/profile?user_id=${encodeURIComponent(body.learner_id)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      learnerName = data.name || data.displayName || '';
      learnerSkills = data.skills || [];
      learnerGoals = data.goals || '';
    }
  } catch {
    setAttr(dataSpan, 'profile_unavailable', true);
  }

  // 2. Fetch progress
  let enrollments: EnrollmentSummary[] = [];
  let completedCount = 0;
  const stalledModules: string[] = [];
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/progress/user?userId=${body.learner_id}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      const items = data.enrollments || [];
      for (const e of items) {
        const pct = parseInt(e.progressPercent || '0') || 0;
        const title = e.courseTitle || e.title || '';
        enrollments.push({
          id: e.enrollmentId || e.id || '',
          title,
          status: e.status || 'enrolled',
          progressPercent: pct,
          courseId: e.courseId || '',
        });
        if (e.status === 'completed') completedCount++;
        // Stalled: in_progress with low progress (< 30%)
        if (pct > 0 && pct < 30 && e.status !== 'completed') {
          if (title) stalledModules.push(title);
        }
      }
    }
  } catch {
    setAttr(dataSpan, 'progress_unavailable', true);
  }

  setAttr(dataSpan, 'enrollment_count', enrollments.length);
  setAttr(dataSpan, 'completed_lessons', completedCount);
  setAttr(dataSpan, 'stalled_modules', stalledModules.length);

  // 3. Fetch assessment summary
  let avgScore = 0;
  let lowestTopic = '';
  let totalAttempts = 0;
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/learner/assessments/summary?userId=${encodeURIComponent(body.learner_id)}&organization_id=${encodeURIComponent(body.org_id)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      avgScore = Math.round(data.avg_score_percent || 0);
      lowestTopic = data.lowest_topic || '';
      totalAttempts = data.total_attempts || 0;
    }
  } catch {
    setAttr(dataSpan, 'assessments_unavailable', true);
  }

  setAttr(dataSpan, 'avg_quiz_score', avgScore);
  setAttr(dataSpan, 'total_quiz_attempts', totalAttempts);
  setAttr(dataSpan, 'has_lowest_topic', !!lowestTopic);
  endSpan(dataSpan);

  // ── Build recent_activity ──
  const recentActivity = {
    completed_lessons: completedCount,
    quiz_scores: { avg: avgScore, lowest_topic: lowestTopic || 'none' },
    stalled_modules: stalledModules,
  };

  // ── Empty-state check: no LMS data at all ──
  const hasAnyData = enrollments.length > 0 || totalAttempts > 0 || learnerSkills.length > 0;

  // ═══════════════════════════════════════════════════════
  //  Build the session prep prompt
  // ═══════════════════════════════════════════════════════
  const prompt = buildSessionPrepPrompt(
    learnerName,
    learnerSkills,
    learnerGoals,
    enrollments,
    stalledModules,
    completedCount,
    avgScore,
    lowestTopic,
  );

  // ═══════════════════════════════════════════════════════
  //  SPAN: session_prep.agenda_generate — LLM call + parsing
  // ═══════════════════════════════════════════════════════
  const agendaSpan = startSpan('session_prep.agenda_generate');
  setAttr(agendaSpan, 'org_id', body.org_id);
  setAttr(agendaSpan, 'has_activity_data', hasAnyData);

  try {
    // ── Call AI03 Gateway ──
    const gwSpan = startSpan('ai_gateway.generate');
    setAttr(gwSpan, 'tier', 'standard');

    const result = await callGateway(env.AI_GATEWAY, prompt, body.org_id);

    setAttr(gwSpan, 'status', result ? 200 : 502);
    endSpan(gwSpan);

    if (!result) {
      setAttr(agendaSpan, 'ai_gateway_error', true);
      setAttr(agendaSpan, 'ai_status', 'degraded');
      endSpan(agendaSpan);
      return json(skeletonPrepResponse(recentActivity, stalledModules, enrollments), 200);
    }

    setAttr(agendaSpan, 'llm_model', result.model);
    setAttr(agendaSpan, 'llm_tokens', result.tokens);

    // Parse LLM response
    const parsed = parseSessionPrepAgenda(
      result.text,
      agendaSpan,
      recentActivity,
      stalledModules,
      enrollments,
    );

    setAttr(agendaSpan, 'ai_status', 'generated');
    setAttr(agendaSpan, 'agenda_item_count', parsed.suggested_agenda.length);
    setAttr(agendaSpan, 'prep_material_count', parsed.prep_materials.length);
    endSpan(agendaSpan);

    return json(parsed, 200);
  } catch (err: any) {
    setAttr(agendaSpan, 'ai_gateway_error', true);
    setAttr(agendaSpan, 'ai_status', 'degraded');
    setAttr(agendaSpan, 'error', err.message);
    endSpan(agendaSpan);
    return json(skeletonPrepResponse(recentActivity, stalledModules, enrollments), 200);
  }
}

// ════════════════════════════════════════════════════════
//  Session Prep Prompt Builder
// ════════════════════════════════════════════════════════

function buildSessionPrepPrompt(
  learnerName: string,
  skills: string[],
  goals: string,
  enrollments: EnrollmentSummary[],
  stalledModules: string[],
  completedCount: number,
  avgScore: number,
  lowestTopic: string,
): string {
  const progressSummary = enrollments
    .map((e) => {
      const marker = e.status === 'completed' ? ' [COMPLETED]' : ` [${e.progressPercent}%]`;
      return `  - ${e.title}${marker}`;
    })
    .join('\n') || '  (no course data)';

  const quizSummary = avgScore > 0
    ? `Average quiz score: ${avgScore}%. Lowest performing topic: "${lowestTopic || 'none'}".`
    : 'No quiz data available yet.';

  const stalledSummary = stalledModules.length > 0
    ? stalledModules.map((m) => `  - ${m}`).join('\n')
    : '  (none — all courses progressing well)';

  return [
    `You are an expert mentor coach. Generate a structured session preparation agenda for a mentor meeting with a learner.`,
    ``,
    `LEARNER CONTEXT:`,
    learnerName ? `  Name: ${learnerName}` : '',
    skills.length > 0 ? `  Skills: ${skills.join(', ')}` : '',
    goals ? `  Goals: ${goals}` : '',
    ``,
    `COURSE PROGRESS:`,
    `  Completed courses: ${completedCount}`,
    `  Enrollments:`,
    progressSummary,
    ``,
    `QUIZ PERFORMANCE:`,
    `  ${quizSummary}`,
    ``,
    `STALLED MODULES (low progress, may need attention):`,
    stalledSummary,
    ``,
    `INSTRUCTIONS:`,
    `1. Generate a 3-topic session agenda prioritized by urgency.`,
    `2. Low quiz scores and stalled modules are highest priority.`,
    `3. Each agenda item MUST include: topic, reason (specific to this learner), and duration_min (integer).`,
    `4. If no quiz data, still suggest a productive agenda from progress + skills.`,
    `5. Be specific — mention actual course names, topics, or skills from the context.`,
    `6. Never fabricate data — if context is sparse, focus on goal-setting and progress review.`,
    ``,
    `Return a JSON object. No other text.`,
    `Format: {"agenda":[{"topic":"Topic name","reason":"Why this is important for this learner","duration_min":15}]}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ════════════════════════════════════════════════════════
//  Session Prep Response Parser
// ════════════════════════════════════════════════════════

function parseSessionPrepAgenda(
  response: string,
  agendaSpan: SpanContext,
  recentActivity: SessionPrepResponse['recent_activity'],
  stalledModules: string[],
  enrollments: EnrollmentSummary[],
): SessionPrepResponse {
  const parsed = parseLlmJson<{
    agenda?: Array<{ topic?: string; reason?: string; duration_min?: number }>;
  }>(response);

  if (!parsed || !parsed.agenda || !Array.isArray(parsed.agenda)) {
    setAttr(agendaSpan, 'parse_failed', response.includes('{') ? 'json_error' : 'no_json');
    return skeletonPrepResponse(recentActivity, stalledModules, enrollments);
  }

  // Normalize agenda items — ensure topic, reason, duration_min exist
  const agenda: AgendaItem[] = parsed.agenda
    .filter((item) => item && (item.topic || item.reason))
    .map((item) => ({
      topic: String(item.topic || 'Review session'),
      reason: String(item.reason || 'Review learner progress'),
      duration_min: typeof item.duration_min === 'number' ? item.duration_min : 15,
    }))
    .slice(0, 5);

  if (agenda.length === 0) {
    return skeletonPrepResponse(recentActivity, stalledModules, enrollments);
  }

  // Build prep materials from enrollments that match agenda topics
  const prepMaterials: PrepMaterial[] = buildPrepMaterials(agenda, enrollments, stalledModules);

  return {
    recent_activity: recentActivity,
    suggested_agenda: agenda,
    prep_materials: prepMaterials,
    ai_status: 'generated',
  };
}

// ════════════════════════════════════════════════════════
//  Prep Materials Builder
// ════════════════════════════════════════════════════════

function buildPrepMaterials(
  agenda: AgendaItem[],
  enrollments: EnrollmentSummary[],
  stalledModules: string[],
): PrepMaterial[] {
  const materials: PrepMaterial[] = [];
  const usedCourseIds = new Set<string>();

  // Strategy: match agenda topic keywords against enrollment titles,
  // then fall back to stalled modules, then any enrollment.
  for (const item of agenda) {
    const topicTokens = tokenize(item.topic);
    let bestMatch: EnrollmentSummary | null = null;
    let bestScore = 0;

    for (const e of enrollments) {
      if (!e.courseId || usedCourseIds.has(e.courseId)) continue;
      const score = overlapScore(topicTokens, tokenize(e.title));
      if (score > bestScore) {
        bestScore = score;
        bestMatch = e;
      }
    }

    if (bestMatch && bestMatch.courseId) {
      usedCourseIds.add(bestMatch.courseId);
      materials.push({
        lesson_title: bestMatch.title,
        link: `/courses/${bestMatch.courseId}`,
      });
      continue;
    }

    // Fallback: use stalled modules (course name as title)
    for (const stalled of stalledModules) {
      const stalledKey = stalled.toLowerCase();
      if (!usedCourseIds.has(stalledKey)) {
        usedCourseIds.add(stalledKey);
        // Find the enrollment matching this stalled module
        const match = enrollments.find((e) => e.title === stalled);
        materials.push({
          lesson_title: stalled,
          link: match?.courseId ? `/courses/${match.courseId}` : `/courses`,
        });
        break;
      }
    }
  }

  // If no materials matched, add any available enrollment
  if (materials.length === 0 && enrollments.length > 0) {
    const first = enrollments.find((e) => e.courseId);
    if (first) {
      materials.push({
        lesson_title: first.title,
        link: `/courses/${first.courseId}`,
      });
    }
  }

  return materials;
}

// ════════════════════════════════════════════════════════
//  Skeleton / Placeholder Response
// ════════════════════════════════════════════════════════

function skeletonPrepResponse(
  recentActivity: SessionPrepResponse['recent_activity'],
  stalledModules: string[],
  enrollments: EnrollmentSummary[],
): SessionPrepResponse {
  const agenda: AgendaItem[] = [
    {
      topic: 'Review learner profile',
      reason: 'Understand background, skills, and goals',
      duration_min: 10,
    },
    {
      topic: 'Assess current progress',
      reason: 'Review completed courses and identify gaps',
      duration_min: 15,
    },
    {
      topic: 'Set session goals',
      reason: 'Align on priorities for today and next steps',
      duration_min: 10,
    },
  ];

  // Include stalled module info in agenda if available
  if (stalledModules.length > 0) {
    agenda.splice(1, 0, {
      topic: `Unblock: ${stalledModules[0]}`,
      reason: 'Low progress — learner may be stuck',
      duration_min: 15,
    });
  }

  // Build prep materials from available enrollments
  const prepMaterials: PrepMaterial[] = enrollments
    .filter((e) => e.courseId)
    .slice(0, 3)
    .map((e) => ({
      lesson_title: e.title,
      link: `/courses/${e.courseId}`,
    }));

  return {
    recent_activity: recentActivity,
    suggested_agenda: agenda.slice(0, 5),
    prep_materials: prepMaterials,
    ai_status: 'degraded',
  };
}
