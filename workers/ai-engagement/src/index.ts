// ============================================================
// F04b: Engagement Monitoring
// ============================================================
// GET /admin/engagement?org_id={org}&period=last_30_days
//
// Monitors learner engagement patterns across an org. Identifies
// video drop-offs, course stall rates, time-of-day patterns, and
// content consumption trends — with AI-generated suggestions to
// improve retention.
// ============================================================

import { fetchLms } from '../../shared/fetch-lms';
import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan } from '../../shared/observability';
import { callGateway } from '../../shared/gateway';
import { parseLlmJson } from '../../shared/llm-parser';
import type { BaseEnv } from '../../shared/env';

export interface Env extends BaseEnv {}

// ──── LMS Response Types ────

/** Video engagement entry from GET /v1/admin/engagement */
interface EngagementVideo {
  video_id: string;
  video_title: string;
  course_title: string;
  views: number;
  avg_watch_percent: number;
  drop_off_at_seconds: number | null;
  completion_rate: number;
}

/** Course engagement entry */
interface EngagementCourse {
  course_id: string;
  course_title: string;
  enrolled_learners: number;
  completion_rate: number;
  avg_time_per_week_minutes: number;
  stall_rate: number;
}

/** Activity patterns */
interface ActivityPatterns {
  by_hour: Record<string, number>;
  by_day_of_week: Record<string, number>;
  peak_hour: number | null;
  peak_day: string | null;
  off_peak_hours: number[];
}

/** LMS engagement aggregate response */
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

type InsightType = 'video_dropoff' | 'course_stall' | 'timing_pattern';
type Severity = 'high' | 'medium' | 'low';

/** A raw pattern detected from data — before AI enrichment */
interface RawPattern {
  type: InsightType;
  severity: Severity;
  title: string;
  affected_learners: number;
  data: string;
}

/** AI-enriched insight returned to client */
interface Insight {
  type: InsightType;
  severity: Severity;
  finding: string;
  suggestion: string;
  affected_learners: number;
  evidence: string;
}

interface EngagementResponse {
  org_id: string;
  period: string;
  learner_count: number;
  insights: Insight[];
  ai_status: string;
  generated_at: string;
}

// ════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════

/** Minimum learner count — orgs below this get "insufficient data" */
const MINIMUM_COHORT = 10;

/** Video completion rate threshold — below this = drop-off */
const VIDEO_DROPOFF_THRESHOLD = 0.60;

/** Course stall rate threshold — at/above this = stall */
const COURSE_STALL_THRESHOLD = 0.25;

/** Max number of raw patterns to send to AI (avoid prompt bloat) */
const MAX_RAW_PATTERNS = 20;

/** Max insights in response (cap to avoid overwhelming clients) */
const MAX_INSIGHTS = 15;

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'ai-engagement' });
    }

    if (req.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (url.pathname === '/admin/engagement') {
      const orgId = url.searchParams.get('org_id') || '';
      const period = url.searchParams.get('period') || 'last_30_days';

      if (!orgId) {
        return json({ error: 'missing_field: org_id' }, 400);
      }

      return handleEngagement(orgId, period, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ════════════════════════════════════════════════════════
//  GET /admin/engagement
// ════════════════════════════════════════════════════════

async function handleEngagement(
  orgId: string,
  period: string,
  env: Env,
): Promise<Response> {
  // ═══════════════════════════════════════════════════════
  //  SPAN: data.fetch — gather aggregate engagement data
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan('data.fetch');
  setAttr(dataSpan, 'org_id', orgId);
  setAttr(dataSpan, 'period', period);

  // ── Fetch engagement data from LMS ──
  let engagementData: EngagementData | null = null;
  try {
    const resp = await fetchLms(env, {
      path: `/api/v1/admin/engagement?organization_id=${encodeURIComponent(orgId)}&period=${encodeURIComponent(period)}`,
    });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      if (data && typeof data === 'object') {
        engagementData = data as EngagementData;
      }
    }
  } catch {
    setAttr(dataSpan, 'lms_unreachable', true);
  }

  if (!engagementData) {
    endSpan(dataSpan);
    return json(placeholderResponse(orgId, period), 200);
  }

  const learnerCount = engagementData.total_active_learners;

  setAttr(dataSpan, 'total_learners', learnerCount);
  setAttr(dataSpan, 'video_count', engagementData.video_engagement?.length ?? 0);
  setAttr(dataSpan, 'course_count', engagementData.course_engagement?.length ?? 0);

  // ── Cohort check ──
  if (learnerCount < MINIMUM_COHORT) {
    setAttr(dataSpan, 'cohort_too_small', true);
    endSpan(dataSpan);
    return insufficientDataResponse(orgId, period, learnerCount);
  }

  // ═══════════════════════════════════════════════════════
  //  Compute raw patterns from engagement data
  // ═══════════════════════════════════════════════════════
  const { rawPatterns, videoCount, courseCount } = computePatterns(engagementData);

  setAttr(dataSpan, 'videos_analyzed', videoCount);
  setAttr(dataSpan, 'courses_analyzed', courseCount);
  setAttr(dataSpan, 'raw_patterns', rawPatterns.length);
  endSpan(dataSpan);

  // ── No patterns found ──
  if (rawPatterns.length === 0) {
    return json({
      org_id: orgId,
      period: engagementData.period || period,
      learner_count: learnerCount,
      insights: [],
      ai_status: 'none_needed',
      generated_at: new Date().toISOString(),
    }, 200);
  }

  // ═══════════════════════════════════════════════════════
  //  Build prompt, call AI03 Gateway
  // ═══════════════════════════════════════════════════════
  const prompt = buildEngagementPrompt(orgId, period, learnerCount, rawPatterns);

  const insightSpan = startSpan('insight.generate');
  setAttr(insightSpan, 'org_id', orgId);
  setAttr(insightSpan, 'pattern_count', rawPatterns.length);

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
      return json(degradedResponse(orgId, period, learnerCount, rawPatterns), 200);
    }

    setAttr(insightSpan, 'llm_model', result.model);
    setAttr(insightSpan, 'llm_tokens', result.tokens);

    // Parse LLM response
    const { insights, parsed } = parseInsights(result.text, rawPatterns);

    const aiStatus = parsed ? 'generated' : 'degraded';
    setAttr(insightSpan, 'ai_status', aiStatus);
    setAttr(insightSpan, 'enriched_count', insights.length);
    setAttr(insightSpan, 'parse_failed', !parsed);
    endSpan(insightSpan);

    return json({
      org_id: orgId,
      period: engagementData.period || period,
      learner_count: learnerCount,
      insights: insights.slice(0, MAX_INSIGHTS),
      ai_status: aiStatus,
      generated_at: new Date().toISOString(),
    }, 200);
  } catch (err: any) {
    setAttr(insightSpan, 'ai_gateway_error', true);
    setAttr(insightSpan, 'ai_status', 'degraded');
    setAttr(insightSpan, 'error', err.message);
    endSpan(insightSpan);
    return json(degradedResponse(orgId, period, learnerCount, rawPatterns), 200);
  }
}

// ════════════════════════════════════════════════════════
//  Pattern Computation
// ════════════════════════════════════════════════════════

function computePatterns(
  data: EngagementData,
): { rawPatterns: RawPattern[]; videoCount: number; courseCount: number } {
  const patterns: RawPattern[] = [];

  // ── Video drop-off detection ──
  const videos = data.video_engagement ?? [];
  for (const vid of videos) {
    if (vid.completion_rate < VIDEO_DROPOFF_THRESHOLD) {
      const severity = vid.completion_rate < 0.30 ? 'high' :
        vid.completion_rate < 0.50 ? 'medium' : 'low';

      const dropOffInfo = vid.drop_off_at_seconds
        ? `drop-off at ${Math.floor(vid.drop_off_at_seconds / 60)}:${String(vid.drop_off_at_seconds % 60).padStart(2, '0')}`
        : 'drop-off point unknown';

      patterns.push({
        type: 'video_dropoff',
        severity,
        title: `${vid.video_title} (${vid.course_title})`,
        affected_learners: vid.views,
        data: `${vid.video_title} in ${vid.course_title}: completion=${(vid.completion_rate * 100).toFixed(0)}%, avg_watch=${vid.avg_watch_percent}%, ${dropOffInfo}, ${vid.views} views`,
      });
    }
  }

  // ── Course stall detection ──
  const courses = data.course_engagement ?? [];
  for (const course of courses) {
    if (course.stall_rate >= COURSE_STALL_THRESHOLD) {
      const severity = course.stall_rate >= 0.50 ? 'high' :
        course.stall_rate >= 0.35 ? 'medium' : 'low';

      patterns.push({
        type: 'course_stall',
        severity,
        title: course.course_title,
        affected_learners: course.enrolled_learners,
        data: `${course.course_title}: stall_rate=${(course.stall_rate * 100).toFixed(0)}%, completion=${(course.completion_rate * 100).toFixed(0)}%, enrolled=${course.enrolled_learners}, avg_time=${course.avg_time_per_week_minutes}min/week`,
      });
    }
  }

  // ── Activity timing patterns ──
  const activity = data.activity_patterns;
  if (activity) {
    const offPeakHours = activity.off_peak_hours ?? [];
    if (offPeakHours.length > 0) {
      const lowestHour = activity.peak_hour
        ? `vs peak hour ${activity.peak_hour}:00`
        : '';

      patterns.push({
        type: 'timing_pattern',
        severity: 'low',
        title: 'Off-peak engagement hours',
        affected_learners: data.total_active_learners,
        data: `Off-peak hours: ${offPeakHours.map(h => `${h}:00`).join(', ')}. Peak: ${activity.peak_hour ?? 'unknown'}:00, ${activity.peak_day ?? 'unknown'}. ${data.total_active_learners} active learners ${lowestHour}`,
      });
    }
  }

  // Cap before sending to AI
  return {
    rawPatterns: patterns.slice(0, MAX_RAW_PATTERNS),
    videoCount: videos.length,
    courseCount: courses.length,
  };
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildEngagementPrompt(
  orgId: string,
  period: string,
  learnerCount: number,
  rawPatterns: RawPattern[],
): string {
  const patternsBlock = rawPatterns
    .map((p, i) => `${i + 1}. [${p.type}] ${p.data}`)
    .join('\n');

  return [
    `You are a learning engagement analyst. Analyze these engagement patterns and generate actionable insights to improve learner retention.`,
    ``,
    `ORG: ${orgId}`,
    `PERIOD: ${period}`,
    `ACTIVE LEARNERS: ${learnerCount}`,
    ``,
    `ENGAGEMENT PATTERNS DETECTED:`,
    patternsBlock || '  (none detected)',
    ``,
    `For each pattern, generate:`,
    `  - type: "video_dropoff", "course_stall", or "timing_pattern" (from the data)`,
    `  - severity: "high" (critical retention risk), "medium" (needs attention), "low" (informational)`,
    `  - finding: one-sentence description of what the data shows about learner behavior`,
    `  - suggestion: one actionable recommendation to improve engagement/retention`,
    `  - affected_learners: the number from the data`,
    `  - evidence: one sentence with specific data points backing the finding`,
    ``,
    `RULES:`,
    `1. Be specific — reference video/course names and exact metrics from the data.`,
    `2. Never fabricate data. Use only the numbers provided.`,
    `3. Suggestions must be actionable (e.g., "add progress markers at 50%", "send re-engagement email after 7 days inactive").`,
    `4. Order by severity (high first).`,
    `5. Include the original type, affected_learners, and severity from the data for each pattern.`,
    `6. Skip patterns where the data doesn't support a clear insight — do not hallucinate.`,
    `7. If there are off-peak timing patterns, generate a timing_pattern insight. Otherwise omit it.`,
    ``,
    `Return a JSON object. No other text.`,
    `Format: {"insights":[{"type":"video_dropoff|course_stall|timing_pattern","severity":"high|medium|low","finding":"...","suggestion":"...","affected_learners":0,"evidence":"..."}]}`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

interface LlmInsightItem {
  type?: string;
  severity?: string;
  finding?: string;
  suggestion?: string;
  affected_learners?: number;
  evidence?: string;
}

function parseInsights(
  response: string,
  rawPatterns: RawPattern[],
): { insights: Insight[]; parsed: boolean } {
  const parsed = parseLlmJson<{ insights?: LlmInsightItem[] }>(response);

  if (!parsed || !parsed.insights || !Array.isArray(parsed.insights)) {
    return { insights: buildSkeletonInsights(rawPatterns), parsed: false };
  }

  const llmItems = parsed.insights;

  // Map LLM items back to raw patterns by type + title + severity
  const byKey = new Map<string, RawPattern>();
  for (const raw of rawPatterns) {
    const key = `${raw.type}::${raw.title}::${raw.severity}`;
    byKey.set(key, raw);
  }

  const insights: Insight[] = [];

  for (const item of llmItems) {
    const itemType = normalizeType(item.type);
    const itemSeverity = normalizeSeverity(item.severity);

    // Try to match back to a raw pattern
    // Build lookup key — LLM may reorder or change title slightly
    let matched = false;
    for (const [key, raw] of byKey) {
      if (key.startsWith(`${itemType}::`) && key.endsWith(`::${itemSeverity}`)) {
        insights.push({
          type: raw.type,
          severity: itemSeverity,
          finding: sanitize(item.finding) || `${raw.title}: engagement concern detected.`,
          suggestion: sanitize(item.suggestion) || `Review ${raw.title} for improvement opportunities.`,
          affected_learners: raw.affected_learners,
          evidence: sanitize(item.evidence) || raw.data,
        });
        byKey.delete(key);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // LLM generated an insight that matches no raw pattern — skip (anti-hallucination)
      continue;
    }
  }

  // Any raw patterns the LLM missed — add with skeleton enrichment
  for (const raw of rawPatterns) {
    const key = `${raw.type}::${raw.title}::${raw.severity}`;
    if (!byKey.has(key)) continue;
    insights.push(...buildSkeletonInsights([raw]));
  }

  return { insights, parsed: true };
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function normalizeType(raw: string | undefined): InsightType {
  if (!raw) return 'video_dropoff';
  const s = raw.toLowerCase();
  if (s.includes('stall') || s.includes('course')) return 'course_stall';
  if (s.includes('timing') || s.includes('pattern') || s.includes('hour') || s.includes('peak')) return 'timing_pattern';
  return 'video_dropoff';
}

function normalizeSeverity(raw: string | undefined): Severity {
  if (!raw) return 'medium';
  const s = raw.toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('low')) return 'low';
  return 'medium';
}

function isValidType(t: string): t is InsightType {
  return t === 'video_dropoff' || t === 'course_stall' || t === 'timing_pattern';
}

/** Sanitize an LLM-generated string — strip quotes, trim, cap length. */
import { sanitize } from '../../shared/sanitize';

/** Build skeleton insights from raw patterns when LLM is unavailable. */
function buildSkeletonInsights(rawPatterns: RawPattern[]): Insight[] {
  return rawPatterns.map((raw) => {
    let finding = '';
    let suggestion = '';

    switch (raw.type) {
      case 'video_dropoff':
        finding = `Video ${raw.title} has low completion rate — learners may be disengaging.`;
        suggestion = `Consider shortening video or adding interactive checkpoints.`;
        break;
      case 'course_stall':
        finding = `Course ${raw.title} has elevated stall rate — learners may be stuck.`;
        suggestion = `Add progress reminders or re-engagement nudges after periods of inactivity.`;
        break;
      case 'timing_pattern':
        finding = `Learner activity shows significant off-peak periods.`;
        suggestion = `Schedule content releases and maintenance during off-peak hours.`;
        break;
    }

    return {
      type: raw.type,
      severity: raw.severity,
      finding,
      suggestion,
      affected_learners: raw.affected_learners,
      evidence: raw.data,
    };
  });
}

// ════════════════════════════════════════════════════════
//  Response Builders
// ════════════════════════════════════════════════════════

function placeholderResponse(orgId: string, period: string): EngagementResponse {
  return {
    org_id: orgId,
    period,
    learner_count: 0,
    insights: [],
    ai_status: 'degraded',
    generated_at: new Date().toISOString(),
  };
}

function insufficientDataResponse(orgId: string, period: string, count: number) {
  return json({
    org_id: orgId,
    period,
    learner_count: count,
    message: `Insufficient data — minimum ${MINIMUM_COHORT} learners required, found ${count}.`,
    insights: [],
    ai_status: 'insufficient_data',
    generated_at: new Date().toISOString(),
  }, 200);
}

function degradedResponse(
  orgId: string,
  period: string,
  learnerCount: number,
  rawPatterns: RawPattern[],
): EngagementResponse {
  return {
    org_id: orgId,
    period,
    learner_count: learnerCount,
    insights: buildSkeletonInsights(rawPatterns).slice(0, MAX_INSIGHTS),
    ai_status: 'degraded',
    generated_at: new Date().toISOString(),
  };
}
