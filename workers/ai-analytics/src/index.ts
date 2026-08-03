// ============================================================
// F05: Admin Analytics Narratives
// ============================================================
// GET /admin/narrative?org_id={org}&period=last_30_days
//
// Generates natural-language narratives from aggregate LMS
// analytics data. Compares current vs previous period, surfaces
// highlights (positive/warning), and returns raw metrics.
// Uses quality-tier LLM for richer, more nuanced narratives.
// ============================================================

import { fetchLms } from '../../shared/fetch-lms';
import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan } from '../../shared/observability';
import { callGateway } from '../../shared/gateway';
import { parseLlmJson } from '../../shared/llm-parser';
import type { BaseEnv } from '../../shared/env';

export interface Env extends BaseEnv {}

// ──── LMS Response Types ────

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
  suppressed?: boolean;
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

interface AssessmentTopic {
  topic: string;
  avg_score: number;
  attempts: number;
  benchmark?: number;
}

interface AssessmentsAggregateData {
  period: string;
  topics: string; // JSON-encoded AssessmentTopic[]
  overall: {
    avg_quiz_score: number;
    total_quizzes_completed: number;
    score_trend: 'up' | 'down' | 'flat';
  };
}

interface EngagementVideo {
  video_id: string;
  video_title: string;
  course_title: string;
  views: number;
  avg_watch_percent: number;
  drop_off_at_seconds: number | null;
  completion_rate: number;
}

interface EngagementCourse {
  course_id: string;
  course_title: string;
  enrolled_learners: number;
  completion_rate: number;
  avg_time_per_week_minutes: number;
  stall_rate: number;
}

interface ActivityPatterns {
  by_hour: Record<string, number>;
  by_day_of_week: Record<string, number>;
  peak_hour: number | null;
  peak_day: string | null;
  off_peak_hours: number[];
}

interface EngagementData {
  period: string;
  total_active_learners: number;
  course_engagement: EngagementCourse[];
  video_engagement: EngagementVideo[];
  activity_patterns: ActivityPatterns;
  overall: {
    avg_completion_rate: number;
    avg_time_per_week_minutes: number;
    total_videos_watched: number;
  };
}

// ──── Internal Types ────

type Sentiment = 'positive' | 'warning' | 'neutral';

interface Highlight {
  sentiment: Sentiment;
  finding: string;
  evidence: string;
  likely_cause: string | null;
}

interface Metrics {
  active_learners: number;
  avg_progress_pct: number;
  courses_completed: number;
  avg_quiz_score: number;
  engagement_trend: 'up' | 'down' | 'flat' | 'unavailable';
  period_comparison: boolean;
}

interface NarrativeResponse {
  org_id: string;
  period: string;
  summary: string;
  highlights: Highlight[];
  metrics: Metrics;
  ai_status: string;
  generated_at: string;
}

// ──── Previous Period Data ────

interface PreviousPeriodData {
  available: boolean;
  progress: ProgressAggregateData | null;
  assessments: AssessmentsAggregateData | null;
}

// ════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════

const MINIMUM_COHORT = 10;
const QUALITY_TIER = 'quality';

/** Significant change thresholds for highlights */
const QUIZ_CHANGE_THRESHOLD = 5; // percentage points
const COMPLETION_CHANGE_THRESHOLD = 5; // percentage points
// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'ai-analytics' });
    }

    if (req.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/admin/narrative') {
      const orgId = url.searchParams.get('org_id') || '';
      const period = url.searchParams.get('period') || 'last_30_days';

      if (!orgId) {
        return json({ error: 'missing_field: org_id' }, 400);
      }

      return handleNarrative(orgId, period, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  GET /admin/narrative
// ════════════════════════════════════════════════════════

async function handleNarrative(
  orgId: string,
  period: string,
  env: Env,
): Promise<Response> {
  // ═══════════════════════════════════════════════════════
  //  SPAN: data.fetch
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan('data.fetch');
  setAttr(dataSpan, 'org_id', orgId);
  setAttr(dataSpan, 'period', period);

  // ── Fetch current period data ──
  const [progress, assessments, engagement, previous] = await Promise.all([
    fetchProgress(orgId, period, env, dataSpan),
    fetchAssessments(orgId, period, env, dataSpan),
    fetchEngagement(orgId, period, env, dataSpan),
    fetchPreviousPeriod(orgId, period, env),
  ]);

  const progressOk = progress !== null;
  const assessmentOk = assessments !== null;
  const engagementOk = engagement !== null;

  if (!progressOk && !assessmentOk && !engagementOk) {
    setAttr(dataSpan, 'lms_unreachable', true);
    endSpan(dataSpan);
    return json(placeholderResponse(orgId, period), 200);
  }

  const learnerCount = progress?.total_learners
    ?? engagement?.total_active_learners
    ?? 0;

  setAttr(dataSpan, 'total_learners', learnerCount);
  setAttr(dataSpan, 'progress_ok', progressOk);
  setAttr(dataSpan, 'assessment_ok', assessmentOk);
  setAttr(dataSpan, 'engagement_ok', engagementOk);
  setAttr(dataSpan, 'previous_ok', previous.available);

  // ── Cohort check ──
  if (learnerCount < MINIMUM_COHORT) {
    setAttr(dataSpan, 'cohort_too_small', true);
    endSpan(dataSpan);
    return insufficientDataResponse(orgId, period, learnerCount);
  }

  // ═══════════════════════════════════════════════════════
  //  Compute highlights from data
  // ═══════════════════════════════════════════════════════
  const highlights = computeHighlights(progress, assessments, engagement, previous);
  const metrics = computeMetrics(progress, assessments, engagement, previous);

  setAttr(dataSpan, 'highlights', highlights.length);
  setAttr(dataSpan, 'period_comparison', metrics.period_comparison);
  endSpan(dataSpan);

  // ═══════════════════════════════════════════════════════
  //  Build prompt, call AI03 Gateway (quality tier)
  // ═══════════════════════════════════════════════════════
  const prompt = buildNarrativePrompt(orgId, period, learnerCount, metrics, highlights, progress, assessments, engagement, previous);

  const insightSpan = startSpan('insight.generate');
  setAttr(insightSpan, 'org_id', orgId);
  setAttr(insightSpan, 'highlight_count', highlights.length);

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
      return json(degradedResponse(orgId, period, learnerCount, metrics, highlights), 200);
    }

    setAttr(insightSpan, 'llm_model', result.model);
    setAttr(insightSpan, 'llm_tokens', result.tokens);

    const { summary, parsed } = parseNarrative(result.text, highlights, metrics);

    const aiStatus = parsed ? 'generated' : 'degraded';
    setAttr(insightSpan, 'ai_status', aiStatus);
    setAttr(insightSpan, 'parse_failed', !parsed);
    endSpan(insightSpan);

    return json({
      org_id: orgId,
      period,
      summary,
      highlights,
      metrics,
      ai_status: aiStatus,
      generated_at: new Date().toISOString(),
    }, 200);
  } catch (err: any) {
    setAttr(insightSpan, 'ai_gateway_error', true);
    setAttr(insightSpan, 'ai_status', 'degraded');
    setAttr(insightSpan, 'error', err.message);
    endSpan(insightSpan);
    return json(degradedResponse(orgId, period, learnerCount, metrics, highlights), 200);
  }
}

// ════════════════════════════════════════════════════════
//  Data Fetching
// ════════════════════════════════════════════════════════

async function fetchProgress(
  orgId: string,
  period: string,
  env: Env,
  dataSpan: any,
): Promise<ProgressAggregateData | null> {
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/admin/progress/aggregate?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(period)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      if (data && typeof data === 'object') return data as ProgressAggregateData;
    }
    return null;
  } catch {
    setAttr(dataSpan, 'progress_unavailable', true);
    return null;
  }
}

async function fetchAssessments(
  orgId: string,
  period: string,
  env: Env,
  dataSpan: any,
): Promise<AssessmentsAggregateData | null> {
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/admin/assessments/aggregate?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(period)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      if (data && typeof data === 'object') return data as AssessmentsAggregateData;
    }
    return null;
  } catch {
    setAttr(dataSpan, 'assessments_unavailable', true);
    return null;
  }
}

async function fetchEngagement(
  orgId: string,
  period: string,
  env: Env,
  dataSpan: any,
): Promise<EngagementData | null> {
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/admin/engagement?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(period)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      if (data && typeof data === 'object') return data as EngagementData;
    }
    return null;
  } catch {
    setAttr(dataSpan, 'engagement_unavailable', true);
    return null;
  }
}

// ════════════════════════════════════════════════════════
//  Previous Period
// ════════════════════════════════════════════════════════

/** Compute the previous period string from the current one. */
function previousPeriod(current: string): string {
  // "last_30_days" → previous 30-day window
  if (current.startsWith('last_')) {
    const days = parseInt(current.replace('last_', '').replace('_days', ''), 10);
    if (!isNaN(days)) {
      return `previous_${days}_days`;
    }
  }
  return `previous_${current}`;
}

async function fetchPreviousPeriod(
  orgId: string,
  period: string,
  env: Env,
): Promise<PreviousPeriodData> {
  const prev = previousPeriod(period);

  try {
    const [progressResp, assessmentResp] = await Promise.all([
      fetchLms(env, {
        path: `/api/v1/admin/progress/aggregate?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(prev)}`,
      }),
      fetchLms(env, {
        path: `/api/v1/admin/assessments/aggregate?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(prev)}`,
      }),
    ]);

    let progressData: ProgressAggregateData | null = null;
    let assessmentData: AssessmentsAggregateData | null = null;

    if (progressResp.ok) {
      const raw = (await progressResp.json()) as any;
      progressData = (raw.data || raw) as ProgressAggregateData;
    }

    if (assessmentResp.ok) {
      const raw = (await assessmentResp.json()) as any;
      assessmentData = (raw.data || raw) as AssessmentsAggregateData;
    }

    if (progressData || assessmentData) {
      return { available: true, progress: progressData, assessments: assessmentData };
    }

    return { available: false, progress: null, assessments: null };
  } catch {
    return { available: false, progress: null, assessments: null };
  }
}

// ════════════════════════════════════════════════════════
//  Highlight Computation
// ════════════════════════════════════════════════════════

function computeHighlights(
  progress: ProgressAggregateData | null,
  assessments: AssessmentsAggregateData | null,
  engagement: EngagementData | null,
  previous: PreviousPeriodData,
): Highlight[] {
  const highlights: Highlight[] = [];

  // ── Quiz score comparisons ──
  const currentTopics = parseTopics(assessments?.topics);
  const prevTopics = parseTopics(previous.assessments?.topics);

  for (const topic of currentTopics) {
    const prev = prevTopics.find((t) => t.topic === topic.topic);
    if (prev && prev.attempts > 0) {
      const diff = topic.avg_score - prev.avg_score;
      if (Math.abs(diff) >= QUIZ_CHANGE_THRESHOLD) {
        highlights.push({
          sentiment: diff > 0 ? 'positive' : 'warning',
          finding: `Quiz scores on "${topic.topic}" ${diff > 0 ? 'improved' : 'dropped'} ${Math.abs(diff).toFixed(0)} percentage points`,
          evidence: `${prev.avg_score.toFixed(0)}% → ${topic.avg_score.toFixed(0)}% across ${topic.attempts} learners in ${assessments?.period || 'current period'}`,
          likely_cause: null, // LLM will suggest
        });
      }
    }
  }

  // ── Completion rate trend ──
  if (progress && previous.progress) {
    const currentRate = progress.overall.avg_completion_rate * 100;
    const prevRate = previous.progress.overall.avg_completion_rate * 100;
    const diff = currentRate - prevRate;

    if (Math.abs(diff) >= COMPLETION_CHANGE_THRESHOLD) {
      highlights.push({
        sentiment: diff > 0 ? 'positive' : 'warning',
        finding: `Course completion rate ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff).toFixed(0)} percentage points`,
        evidence: `${prevRate.toFixed(0)}% → ${currentRate.toFixed(0)}% across ${progress.total_learners} learners`,
        likely_cause: null,
      });
    }

    // Courses completed
    const completedDiff = progress.overall.courses_completed_this_period
      - previous.progress.overall.courses_completed_this_period;
    if (completedDiff !== 0) {
      highlights.push({
        sentiment: completedDiff > 0 ? 'positive' : 'neutral',
        finding: `${Math.abs(completedDiff)} ${completedDiff > 0 ? 'more' : 'fewer'} courses completed this period`,
        evidence: `${previous.progress.overall.courses_completed_this_period} → ${progress.overall.courses_completed_this_period} courses`,
        likely_cause: null,
      });
    }
  }

  // ── Stall rate warnings ──
  if (engagement) {
    const stalledCourses = engagement.course_engagement.filter(
      (c) => c.stall_rate >= 0.25,
    );
    for (const course of stalledCourses.slice(0, 3)) {
      highlights.push({
        sentiment: 'warning',
        finding: `${course.course_title} has elevated stall rate (${(course.stall_rate * 100).toFixed(0)}%)`,
        evidence: `${course.enrolled_learners} enrolled, ${(course.completion_rate * 100).toFixed(0)}% completion rate`,
        likely_cause: null,
      });
    }
  }

  // ── Top quiz performers (no comparison needed) ──
  const sortedTopics = [...currentTopics].sort((a, b) => b.avg_score - a.avg_score);
  const topTopic = sortedTopics[0];
  if (topTopic && topTopic.avg_score >= 80 && topTopic.attempts >= 5) {
    highlights.push({
      sentiment: 'positive',
      finding: `Strong quiz performance on "${topTopic.topic}" (${topTopic.avg_score.toFixed(0)}% avg)`,
      evidence: `${topTopic.attempts} attempts across the org`,
      likely_cause: null,
    });
  }

  return highlights.slice(0, 10); // cap
}

function parseTopics(raw: string | undefined): AssessmentTopic[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════
//  Metrics Computation
// ════════════════════════════════════════════════════════

function computeMetrics(
  progress: ProgressAggregateData | null,
  assessments: AssessmentsAggregateData | null,
  engagement: EngagementData | null,
  previous: PreviousPeriodData,
): Metrics {
  const activeLearners = progress?.total_learners
    ?? engagement?.total_active_learners
    ?? 0;

  const avgProgress = progress?.overall.avg_completion_rate
    ? Math.round(progress.overall.avg_completion_rate * 100)
    : 0;

  const coursesCompleted = progress?.overall.courses_completed_this_period ?? 0;

  const avgQuizScore = assessments?.overall.avg_quiz_score
    ? Math.round(assessments.overall.avg_quiz_score)
    : 0;

  // Engagement trend: compare current learner count vs previous
  let engagementTrend: Metrics['engagement_trend'] = 'unavailable';
  if (previous.available && previous.progress) {
    const prevLearners = previous.progress.total_learners;
    if (prevLearners > 0) {
      const diff = activeLearners - prevLearners;
      if (diff > 2) engagementTrend = 'up';
      else if (diff < -2) engagementTrend = 'down';
      else engagementTrend = 'flat';
    }
  }

  return {
    active_learners: activeLearners,
    avg_progress_pct: avgProgress,
    courses_completed: coursesCompleted,
    avg_quiz_score: avgQuizScore,
    engagement_trend: engagementTrend,
    period_comparison: previous.available,
  };
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildNarrativePrompt(
  orgId: string,
  period: string,
  learnerCount: number,
  metrics: Metrics,
  highlights: Highlight[],
  progress: ProgressAggregateData | null,
  assessments: AssessmentsAggregateData | null,
  engagement: EngagementData | null,
  previous: PreviousPeriodData,
): string {
  const highlightsBlock = highlights.length > 0
    ? highlights.map((h, i) =>
        `${i + 1}. [${h.sentiment}] ${h.finding}\n   Evidence: ${h.evidence}`).join('\n')
    : '  (no significant highlights detected)';

  const comparisonNote = previous.available
    ? 'Previous period data is available for comparison.'
    : 'No previous period data available — focus on current metrics only.';

  return [
    `You are an analytics narrator for a learning platform. Write a natural-language summary for a non-technical admin.`,
    ``,
    `ORG: ${orgId}`,
    `PERIOD: ${period}`,
    `PREVIOUS PERIOD: ${comparisonNote}`,
    ``,
    `METRICS:`,
    `  Active learners: ${metrics.active_learners}`,
    `  Average course progress: ${metrics.avg_progress_pct}%`,
    `  Courses completed this period: ${metrics.courses_completed}`,
    `  Average quiz score: ${metrics.avg_quiz_score}%`,
    `  Engagement trend: ${metrics.engagement_trend}`,
    ``,
    `HIGHLIGHTS:`,
    highlightsBlock,
    ``,
    `YOUR TASK:`,
    `1. Write a summary (3-5 sentences) that tells the story behind these numbers.`,
    `2. Be encouraging but honest — celebrate wins, flag concerns without alarm.`,
    `3. Reference specific numbers when they support the story.`,
    `4. If previous period data is available, mention what changed.`,
    `5. Never identify individual learners.`,
    `6. For each highlight, suggest a likely_cause if you can infer one from the data.`,
    ``,
    `Return a JSON object. No other text.`,
    `Format: {"summary":"...", "highlights":[{"sentiment":"positive|warning|neutral","finding":"...","evidence":"...","likely_cause":"..."}]}`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

interface LlmHighlightItem {
  sentiment?: string;
  finding?: string;
  evidence?: string;
  likely_cause?: string | null;
}

interface LlmNarrativeResponse {
  summary?: string;
  highlights?: LlmHighlightItem[];
}

function parseNarrative(
  response: string,
  computedHighlights: Highlight[],
  metrics: Metrics,
): { summary: string; parsed: boolean } {
  const parsed = parseLlmJson<LlmNarrativeResponse>(response);

  if (!parsed || !parsed.summary) {
    return {
      summary: buildSkeletonSummary(metrics, computedHighlights),
      parsed: false,
    };
  }

  // Enrich computed highlights with LLM-suggested likely_cause.
  // LLM preserves prompt ordering, so use position-based mapping.
  if (parsed.highlights && Array.isArray(parsed.highlights)) {
    for (let i = 0; i < parsed.highlights.length && i < computedHighlights.length; i++) {
      const item = parsed.highlights[i];
      if (item.likely_cause && !computedHighlights[i].likely_cause) {
        computedHighlights[i].likely_cause = sanitize(item.likely_cause, 800);
      }
    }
  }

  return {
    summary: sanitize(parsed.summary, 800),
    parsed: true,
  };
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

import { sanitize } from '../../shared/sanitize';

function buildSkeletonSummary(metrics: Metrics, highlights: Highlight[]): string {
  const trendWord = metrics.engagement_trend === 'up' ? 'growing' :
    metrics.engagement_trend === 'down' ? 'declining' : 'steady';

  const parts = [
    `Your org has ${metrics.active_learners} active learners with ${trendWord} engagement.`,
  ];

  if (metrics.avg_progress_pct > 0) {
    parts.push(`Average course progress is ${metrics.avg_progress_pct}%.`);
  }

  if (metrics.courses_completed > 0) {
    parts.push(`${metrics.courses_completed} courses were completed this period.`);
  }

  if (metrics.avg_quiz_score > 0) {
    parts.push(`Average quiz score is ${metrics.avg_quiz_score}%.`);
  }

  const warnings = highlights.filter((h) => h.sentiment === 'warning').length;
  const positives = highlights.filter((h) => h.sentiment === 'positive').length;

  if (warnings > 0 && positives > 0) {
    parts.push(`${positives} areas are improving, ${warnings} need attention.`);
  } else if (warnings > 0) {
    parts.push(`${warnings} areas need attention this period.`);
  } else if (positives > 0) {
    parts.push(`${positives} areas showed positive trends.`);
  } else {
    parts.push('No significant changes detected this period.');
  }

  return parts.join(' ');
}

// ════════════════════════════════════════════════════════
//  Response Builders
// ════════════════════════════════════════════════════════

function placeholderResponse(orgId: string, period: string): NarrativeResponse {
  return {
    org_id: orgId,
    period,
    summary: 'Unable to generate narrative — analytics data unavailable.',
    highlights: [],
    metrics: {
      active_learners: 0,
      avg_progress_pct: 0,
      courses_completed: 0,
      avg_quiz_score: 0,
      engagement_trend: 'unavailable',
      period_comparison: false,
    },
    ai_status: 'degraded',
    generated_at: new Date().toISOString(),
  };
}

function insufficientDataResponse(orgId: string, period: string, count: number) {
  return json({
    org_id: orgId,
    period,
    summary: `Not enough data yet for meaningful insights. Only ${count} active ${count === 1 ? 'learner' : 'learners'} — check back when more learners are active.`,
    highlights: [],
    metrics: {
      active_learners: count,
      avg_progress_pct: 0,
      courses_completed: 0,
      avg_quiz_score: 0,
      engagement_trend: 'unavailable',
      period_comparison: false,
    },
    ai_status: 'insufficient_data',
    generated_at: new Date().toISOString(),
  }, 200);
}

function degradedResponse(
  orgId: string,
  period: string,
  learnerCount: number,
  metrics: Metrics,
  highlights: Highlight[],
): NarrativeResponse {
  return {
    org_id: orgId,
    period,
    summary: buildSkeletonSummary(metrics, highlights),
    highlights,
    metrics,
    ai_status: 'degraded',
    generated_at: new Date().toISOString(),
  };
}
