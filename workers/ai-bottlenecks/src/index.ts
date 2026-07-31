// ============================================================
// F04a: Bottleneck Detection
// ============================================================
// GET /admin/bottlenecks?org_id={org}&period=last_90_days
//
// Analyzes aggregate learner data across an org to identify
// where learners consistently stall. Surfaces modules with
// abnormally high completion times, prerequisite gaps, and
// quiz score drops — with AI-generated suggestions.
// ============================================================

import { fetchLms } from '../../shared/fetch-lms';
import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan, type SpanContext } from '../../shared/observability';
import { callGateway } from '../../shared/gateway';
import { parseLlmJson } from '../../shared/llm-parser';
import type { BaseEnv } from '../../shared/env';

export interface Env extends BaseEnv {}

// ──── LMS Response Types ────

/** Module entry from GET /v1/admin/progress/aggregate */
interface ProgressModule {
  module_id: string;
  module_title: string;
  course_id: string;
  course_title: string;
  median_completion_days: number | null;
  expected_completion_days: number;
  enrolled_learners: number;
  completed_learners: number | null;
  stalled_learners: number | null;
  /** When true, the LMS suppressed data (cohort < 10). Use suppressed modules. */
  suppressed?: boolean;
  suppression_reason?: string;
}

interface ProgressAggregateData {
  period: string;
  total_learners: number;
  modules: ProgressModule[];
  overall: {
    avg_completion_rate: number;
    avg_time_on_platform_minutes_per_week: number;
    courses_completed_this_period: number;
  };
}

/** Topic entry from GET /v1/admin/assessments/aggregate (topics is a JSON string) */
interface AssessmentTopic {
  topic: string;
  avg_score: number;
  attempts: number;
  /** Optional: benchmark threshold the LMS or we set */
  benchmark?: number;
}

interface AssessmentsAggregateData {
  period: string;
  /** JSON-encoded string of AssessmentTopic[] */
  topics: string;
  overall: {
    avg_quiz_score: number;
    total_quizzes_completed: number;
    score_trend: 'up' | 'down' | 'flat';
  };
}

// ──── Internal Types ────

/** A single detected bottleneck — computed before AI enrichment */
interface RawBottleneck {
  module: string;
  course: string;
  metric: 'completion_time' | 'quiz_score';
  expected: string;
  actual: string;
  affected_learners: number;
}

/** AI-enriched bottleneck returned to the client */
interface Bottleneck {
  module: string;
  course: string;
  metric: 'completion_time' | 'quiz_score';
  expected: string;
  actual: string;
  affected_learners: number;
  severity: 'high' | 'medium' | 'low';
  finding: string;
  suggestion: string;
  rationale: string;
}

interface BottleneckResponse {
  org_id: string;
  period: string;
  learner_count: number;
  bottlenecks: Bottleneck[];
  ai_status: string;
}

// ════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════

/** Default quiz score benchmark — modules below this are bottlenecks */
const DEFAULT_QUIZ_BENCHMARK = 70;

/** Minimum learner count — orgs below this get "insufficient data" */
const MINIMUM_COHORT = 10;

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'ai-bottlenecks' });
    }

    if (req.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/admin/bottlenecks') {
      const orgId = url.searchParams.get('org_id') || '';
      const period = url.searchParams.get('period') || 'last_90_days';

      if (!orgId) {
        return json({ error: 'missing_field: org_id' }, 400);
      }

      return handleBottlenecks(orgId, period, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  GET /admin/bottlenecks
// ════════════════════════════════════════════════════════

async function handleBottlenecks(
  orgId: string,
  period: string,
  env: Env,
): Promise<Response> {
  // ═══════════════════════════════════════════════════════
  //  SPAN: data.fetch — gather aggregate LMS data
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan('data.fetch');
  setAttr(dataSpan, 'org_id', orgId);
  setAttr(dataSpan, 'period', period);

  // ── 1. Fetch progress aggregate ──
  let progressData: ProgressAggregateData | null = null;
  let progressOk = false;
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/admin/progress/aggregate?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(period)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      if (data && typeof data === 'object') {
        progressData = data as ProgressAggregateData;
        progressOk = true;
      }
    }
  } catch {
    setAttr(dataSpan, 'progress_unavailable', true);
  }

  // ── 2. Fetch assessments aggregate ──
  let assessmentData: AssessmentsAggregateData | null = null;
  let assessmentOk = false;
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/admin/assessments/aggregate?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(period)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      if (data && typeof data === 'object') {
        assessmentData = data as AssessmentsAggregateData;
        assessmentOk = true;
      }
    }
  } catch {
    setAttr(dataSpan, 'assessments_unavailable', true);
  }

  if (!progressOk && !assessmentOk) {
    setAttr(dataSpan, 'lms_unreachable', true);
    endSpan(dataSpan);
    return json(placeholderResponse(orgId, period), 200);
  }

  const learnerCount = progressData?.total_learners ?? 0;

  setAttr(dataSpan, 'total_learners', learnerCount);
  setAttr(dataSpan, 'progress_ok', progressOk);
  setAttr(dataSpan, 'assessment_ok', assessmentOk);

  // ── Cohort check ──
  if (learnerCount < MINIMUM_COHORT) {
    setAttr(dataSpan, 'cohort_too_small', true);
    endSpan(dataSpan);
    return insufficientDataResponse(orgId, period, learnerCount);
  }

  // ═══════════════════════════════════════════════════════
  //  Compute raw bottlenecks from LMS data
  // ═══════════════════════════════════════════════════════
  const { rawBottlenecks, moduleCount, topicCount } = computeBottlenecks(
    progressData,
    assessmentData,
  );

  setAttr(dataSpan, 'modules_analyzed', moduleCount);
  setAttr(dataSpan, 'topics_analyzed', topicCount);
  setAttr(dataSpan, 'raw_bottlenecks', rawBottlenecks.length);
  endSpan(dataSpan);

  // ── No bottlenecks found ──
  if (rawBottlenecks.length === 0) {
    return json({
      org_id: orgId,
      period,
      learner_count: learnerCount,
      bottlenecks: [],
      ai_status: 'none_needed',
    }, 200);
  }

  // ═══════════════════════════════════════════════════════
  //  Build prompt, call AI03 Gateway
  // ═══════════════════════════════════════════════════════
  const prompt = buildBottleneckPrompt(orgId, period, learnerCount, rawBottlenecks);

  const insightSpan = startSpan('insight.generate');
  setAttr(insightSpan, 'org_id', orgId);
  setAttr(insightSpan, 'bottleneck_count', rawBottlenecks.length);

  try {
    const gwSpan = startSpan('ai_gateway.generate');
    setAttr(gwSpan, 'tier', 'standard');

    const result = await callGateway(env.AI_GATEWAY, prompt, orgId);

    setAttr(gwSpan, 'status', result ? 200 : 502);
    endSpan(gwSpan);

    if (!result) {
      setAttr(insightSpan, 'ai_gateway_error', true);
      setAttr(insightSpan, 'ai_status', 'degraded');
      endSpan(insightSpan);
      return json(degradedResponse(orgId, period, learnerCount, rawBottlenecks), 200);
    }

    setAttr(insightSpan, 'llm_model', result.model);
    setAttr(insightSpan, 'llm_tokens', result.tokens);

    // Parse LLM response
    const { bottlenecks, parsed } = parseBottlenecks(result.text, rawBottlenecks);

    const aiStatus = parsed ? 'generated' : 'degraded';
    setAttr(insightSpan, 'ai_status', aiStatus);
    setAttr(insightSpan, 'enriched_count', bottlenecks.length);
    setAttr(insightSpan, 'parse_failed', !parsed);
    endSpan(insightSpan);

    return json({
      org_id: orgId,
      period,
      learner_count: learnerCount,
      bottlenecks,
      ai_status: aiStatus,
    }, 200);
  } catch (err: any) {
    setAttr(insightSpan, 'ai_gateway_error', true);
    setAttr(insightSpan, 'ai_status', 'degraded');
    setAttr(insightSpan, 'error', err.message);
    endSpan(insightSpan);
    return json(degradedResponse(orgId, period, learnerCount, rawBottlenecks), 200);
  }
}

// ════════════════════════════════════════════════════════
//  Bottleneck Computation
// ════════════════════════════════════════════════════════

function computeBottlenecks(
  progressData: ProgressAggregateData | null,
  assessmentData: AssessmentsAggregateData | null,
): { rawBottlenecks: RawBottleneck[]; moduleCount: number; topicCount: number } {
  const bottlenecks: RawBottleneck[] = [];

  // ── Completion time bottlenecks (progress aggregate) ──
  const modules = progressData?.modules ?? [];
  for (const mod of modules) {
    // Skip suppressed modules (LMS already flagged cohort < 10)
    if (mod.suppressed) continue;

    const median = mod.median_completion_days;
    const expected = mod.expected_completion_days;

    // Only flag if median exists and exceeds 2× expected
    if (
      typeof median === 'number' &&
      median > 0 &&
      expected > 0 &&
      median > 2 * expected
    ) {
      bottlenecks.push({
        module: mod.module_title,
        course: mod.course_title,
        metric: 'completion_time',
        expected: `${expected} days`,
        actual: `${median.toFixed(1)} days (median)`,
        affected_learners: mod.enrolled_learners,
      });
    }
  }

  // ── Quiz score bottlenecks (assessments aggregate) ──
  let topics: AssessmentTopic[] = [];
  if (assessmentData?.topics) {
    try {
      topics = JSON.parse(assessmentData.topics);
    } catch {
      // topics not parseable — skip
    }
  }

  for (const topic of topics) {
    const benchmark = topic.benchmark ?? DEFAULT_QUIZ_BENCHMARK;
    if (topic.avg_score < benchmark) {
      bottlenecks.push({
        module: topic.topic,
        course: '', // topics aren't tied to a course in this aggregate
        metric: 'quiz_score',
        expected: `benchmark: ${benchmark}%`,
        actual: `${topic.avg_score.toFixed(0)}%`,
        affected_learners: topic.attempts,
      });
    }
  }

  return {
    rawBottlenecks: bottlenecks,
    moduleCount: modules.length,
    topicCount: topics.length,
  };
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildBottleneckPrompt(
  orgId: string,
  period: string,
  learnerCount: number,
  rawBottlenecks: RawBottleneck[],
): string {
  const bottlenecksBlock = rawBottlenecks
    .map(
      (b, i) =>
        `${i + 1}. Module/Course: ${b.module}${b.course ? ` (${b.course})` : ''} | ` +
        `Metric: ${b.metric} | Expected: ${b.expected} | ` +
        `Actual: ${b.actual} | Affected learners: ${b.affected_learners}`,
    )
    .join('\n');

  return [
    `You are a curriculum analyst. Analyze these bottleneck indicators for an organization and generate actionable insights.`,
    ``,
    `ORG: ${orgId}`,
    `PERIOD: ${period}`,
    `TOTAL LEARNERS: ${learnerCount}`,
    ``,
    `BOTTLENECKS DETECTED:`,
    bottlenecksBlock || '  (none)',
    ``,
    `For each bottleneck, generate:`,
    `  - severity: "high" (median > 4× expected or quiz score < 50%), "medium" (2–4× expected or score 50–69%), "low" (2–3× expected or score 60–69%)`,
    `  - finding: one-sentence description of what the data shows`,
    `  - suggestion: one actionable recommendation for curriculum improvement`,
    `  - rationale: one sentence explaining why this matters, referencing the data`,
    ``,
    `RULES:`,
    `1. Be specific — reference module names, scores, and learner counts from the data.`,
    `2. Never fabricate data. If the metric is clear, use it.`,
    `3. Suggestions must be actionable (e.g., "split module", "add prerequisite", "adjust quiz difficulty").`,
    `4. Order by severity (high first).`,
    `5. Return each bottleneck's fields even if severity is low.`,
    ``,
    `Return a JSON object. No other text.`,
    `Format: {"bottlenecks":[{"module":"...","course":"...","metric":"completion_time|quiz_score","expected":"...","actual":"...","affected_learners":0,"severity":"high|medium|low","finding":"...","suggestion":"...","rationale":"..."}]}`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

interface LlmBottleneckItem {
  module?: string;
  course?: string;
  metric?: string;
  expected?: string;
  actual?: string;
  affected_learners?: number;
  severity?: string;
  finding?: string;
  suggestion?: string;
  rationale?: string;
}

function parseBottlenecks(
  response: string,
  rawBottlenecks: RawBottleneck[],
): { bottlenecks: Bottleneck[]; parsed: boolean } {
  const parsed = parseLlmJson<{ bottlenecks?: LlmBottleneckItem[] }>(response);

  if (!parsed || !parsed.bottlenecks || !Array.isArray(parsed.bottlenecks)) {
    // Degraded: build skeleton from raw data, no AI enrichment
    return { bottlenecks: buildSkeletonBottlenecks(rawBottlenecks), parsed: false };
  }

  const llmItems = parsed.bottlenecks;

  // Map LLM items back to raw bottlenecks by module name + metric match
  // LLM may reorder, but we trust the data fields from raw and enrich with AI-generated fields.
  const byKey = new Map<string, RawBottleneck>();
  for (const raw of rawBottlenecks) {
    const key = `${raw.module}::${raw.metric}`;
    byKey.set(key, raw);
  }

  const bottlenecks: Bottleneck[] = [];

  for (const item of llmItems) {
    const itemModule = item.module || '';
    const itemMetric = (item.metric || 'completion_time') as 'completion_time' | 'quiz_score';
    const key = `${itemModule}::${itemMetric}`;

    // Try exact match first, then fall back to raw data by index
    const raw = byKey.get(key);

    if (!raw) {
      // LLM invented a bottleneck — skip to avoid hallucinated modules
      continue;
    }

    const severity = normalizeSeverity(item.severity);

    bottlenecks.push({
      module: raw.module,
      course: raw.course,
      metric: raw.metric,
      expected: raw.expected,
      actual: raw.actual,
      affected_learners: raw.affected_learners,
      severity,
      finding: sanitize(item.finding) || `Completion time for ${raw.module} exceeds expectations.`,
      suggestion: sanitize(item.suggestion) || `Review ${raw.module} content for improvement opportunities.`,
      rationale: sanitize(item.rationale) || `Affects ${raw.affected_learners} learners.`,
    });
  }

  // Any raw bottlenecks the LLM missed — add with computed severity
  for (const raw of rawBottlenecks) {
    const key = `${raw.module}::${raw.metric}`;
    if (!bottlenecks.some((b) => `${b.module}::${b.metric}` === key)) {
      bottlenecks.push(...buildSkeletonBottlenecks([raw]));
    }
  }

  return { bottlenecks, parsed: true };
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function normalizeSeverity(raw: string | undefined): Bottleneck['severity'] {
  if (!raw) return 'medium';
  const s = raw.toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('low')) return 'low';
  return 'medium';
}

/** Sanitize an LLM-generated string — strip quotes, trim, cap length. */
function sanitize(text: string | undefined): string {
  if (!text) return '';
  return text.replace(/^["']+|["']+$/g, '').trim().slice(0, 300);
}

/** Build skeleton bottleneck items from raw data when LLM is unavailable. */
function buildSkeletonBottlenecks(rawBottlenecks: RawBottleneck[]): Bottleneck[] {
  return rawBottlenecks.map((raw) => {
    let severity: Bottleneck['severity'] = 'medium';

    if (raw.metric === 'completion_time') {
      // Extract multiplier from actual
      const actualDays = parseFloat(raw.actual);
      const expectedDays = parseFloat(raw.expected);
      if (!isNaN(actualDays) && !isNaN(expectedDays) && expectedDays > 0) {
        const ratio = actualDays / expectedDays;
        if (ratio >= 4) severity = 'high';
        else if (ratio >= 2) severity = 'medium';
        else severity = 'low';
      }
    } else if (raw.metric === 'quiz_score') {
      const score = parseFloat(raw.actual);
      if (!isNaN(score)) {
        if (score < 50) severity = 'high';
        else if (score < 70) severity = 'medium';
        else severity = 'low';
      }
    }

    const finding =
      raw.metric === 'completion_time'
        ? `Module ${raw.module} takes ${raw.actual} vs expected ${raw.expected}.`
        : `Quiz scores for ${raw.module} average ${raw.actual} (below benchmark).`;

    return {
      module: raw.module,
      course: raw.course,
      metric: raw.metric,
      expected: raw.expected,
      actual: raw.actual,
      affected_learners: raw.affected_learners,
      severity,
      finding,
      suggestion: `Review ${raw.module} content and structure.`,
      rationale: `Affects ${raw.affected_learners} learners.`,
    };
  });
}

// ════════════════════════════════════════════════════════
//  Response Builders
// ════════════════════════════════════════════════════════

function placeholderResponse(orgId: string, period: string): BottleneckResponse {
  return {
    org_id: orgId,
    period,
    learner_count: 0,
    bottlenecks: [],
    ai_status: 'degraded',
  };
}

function insufficientDataResponse(orgId: string, period: string, count: number) {
  return json({
    org_id: orgId,
    period,
    learner_count: count,
    message: `Insufficient data — minimum ${MINIMUM_COHORT} learners required, found ${count}.`,
    bottlenecks: [],
    ai_status: 'insufficient_data',
  }, 200);
}

function degradedResponse(
  orgId: string,
  period: string,
  learnerCount: number,
  rawBottlenecks: RawBottleneck[],
): BottleneckResponse {
  return {
    org_id: orgId,
    period,
    learner_count: learnerCount,
    bottlenecks: buildSkeletonBottlenecks(rawBottlenecks),
    ai_status: 'degraded',
  };
}
