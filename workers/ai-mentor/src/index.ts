// ============================================================
// AI09: Skill-Gap Analysis (Mentor)
// ============================================================
// Compares learner skills against course catalogue requirements.
// Identifies gaps and recommends courses + estimated effort.
// Fetches profile, catalog, and progress from LMS, builds a
// prompt, and calls AI03 Gateway.
// ============================================================

import { json, handleCors } from '../../shared/cors';
import { startSpan, setAttr, endSpan } from '../../shared/observability';
import { callGateway } from '../../shared/gateway';
import { fetchProfile, fetchCatalog, fetchProgress } from '../../shared/lms-data';
import type { LearnerProfile, CatalogueCourse, ProgressEntry } from '../../shared/lms-data';
import type { BaseEnv } from '../../shared/env';

export interface Env extends BaseEnv {}

// ──── Types ────

interface SkillGap {
  skill: string;
  current_level: string;
  required_level: string;
  courses_available: number;
  estimated_hours: number;
}

interface SkillGapResponse {
  learner_skills: string[];
  gaps: SkillGap[];
  summary: string;
  ai_status: string;
}

// ──── Difficulty → estimated hours ────

const HOURS_BY_DIFFICULTY: Record<string, number> = {
  beginner: 10,
  intermediate: 20,
  advanced: 40,
};

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'ai-mentor' });
    }

    if (url.pathname !== '/mentor/skill-gap') {
      return json({ error: 'not_found' }, 404);
    }

    if (req.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    const learnerId = url.searchParams.get('learner_id');
    const orgId = url.searchParams.get('org_id');

    if (!learnerId) {
      return json({ error: 'missing_param: learner_id' }, 400);
    }
    if (!orgId) {
      return json({ error: 'missing_param: org_id' }, 400);
    }

    return handleSkillGap(learnerId, orgId, env);
  },
};

// ════════════════════════════════════════════════════════
//  GET /mentor/skill-gap
// ════════════════════════════════════════════════════════

async function handleSkillGap(
  learnerId: string,
  orgId: string,
  env: Env,
): Promise<Response> {
  // ═══════════════════════════════════════════════════════
  //  SPAN: data.fetch — gather all LMS data
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan('data.fetch');
  setAttr(dataSpan, 'learner_id', learnerId);
  setAttr(dataSpan, 'org_id', orgId);

  // 1. Fetch learner profile
  let profile: LearnerProfile;
  let profileFromLms = false;
  try {
    const result = await fetchProfile(env);
    profile = result.profile;
    profileFromLms = result.fromLms;
  } catch {
    setAttr(dataSpan, 'lms_profile_error', true);
    endSpan(dataSpan);
    return json(placeholderResponse(), 200);
  }
  setAttr(dataSpan, 'profile_skills', profile.skills.length);
  setAttr(dataSpan, 'profile_from_lms', profileFromLms);

  // 2. Fetch course catalogue
  let catalogue: CatalogueCourse[] = [];
  let catalogFromLms = false;
  try {
    const result = await fetchCatalog(env, orgId);
    catalogue = result.catalogue;
    catalogFromLms = result.fromLms;
  } catch {
    setAttr(dataSpan, 'lms_catalog_error', true);
  }
  setAttr(dataSpan, 'catalog_courses', catalogue.length);
  setAttr(dataSpan, 'catalog_from_lms', catalogFromLms);

  // 3. Fetch learner progress (to exclude completed courses)
  let progress: ProgressEntry[] = [];
  let progressFromLms = false;
  try {
    const result = await fetchProgress(env, learnerId);
    progress = result.progress;
    progressFromLms = result.fromLms;
  } catch {
    setAttr(dataSpan, 'lms_progress_error', true);
  }
  setAttr(dataSpan, 'progress_entries', progress.length);
  setAttr(dataSpan, 'progress_from_lms', progressFromLms);

  // 4. No skills → early return with message
  if (!profile.skills || profile.skills.length === 0) {
    setAttr(dataSpan, 'no_skills', true);
    endSpan(dataSpan);
    return json(
      {
        learner_skills: [],
        gaps: [],
        summary: "No skill data found. Add your skills to your learner profile so we can identify gaps and recommend courses.",
        ai_status: 'degraded',
      },
      200,
    );
  }

  // 5. Pre-compute gap data for the prompt
  const learnerSkillSet = new Set(profile.skills.map((s) => s.toLowerCase().trim()));
  const completedTitles = completedTitleSet(progress);
  const inProgressTitles = new Set(
    progress
      .filter((p) => p.status === 'in_progress')
      .map((p) => p.title.toLowerCase().trim()),
  );

  // Collect all prerequisite skills from courses the learner hasn't finished
  const gapMap = new Map<string, CatalogueCourse[]>();

  for (const course of catalogue) {
    const title = course.title?.toLowerCase().trim() || '';
    if (completedTitles.has(title)) continue;
    for (const prereq of course.prerequisites || []) {
      const prereqLower = prereq.toLowerCase().trim();
      if (!learnerSkillSet.has(prereqLower)) {
        const existing = gapMap.get(prereqLower) || [];
        existing.push(course);
        gapMap.set(prereqLower, existing);
      }
    }
  }
  // Also check category-based gaps: courses in categories the learner has no skills for
  for (const course of catalogue) {
    const title = course.title?.toLowerCase().trim() || '';
    if (completedTitles.has(title) || inProgressTitles.has(title)) continue;
    const cat = course.category?.toLowerCase().trim();
    if (cat && !learnerSkillSet.has(cat) && !gapMap.has(cat)) {
      gapMap.set(cat, [course]);
    }
  }

  // Compute gap summary for prompt
  const gapEntries = Array.from(gapMap.entries()).map(([skill, courses]) => ({
    skill,
    courses_available: courses.length,
    estimated_hours: estimateHoursForCourses(courses),
  }));

  setAttr(dataSpan, 'gaps_identified', gapEntries.length);
  setAttr(dataSpan, 'courses_relevant', catalogue.length);
  endSpan(dataSpan);

  // ═══════════════════════════════════════════════════════
  //  Build the skill-gap analysis prompt
  // ═══════════════════════════════════════════════════════
  const prompt = buildPrompt(profile, gapEntries, catalogue, progress);

  // ═══════════════════════════════════════════════════════
  //  SPAN: skill_gap.generate — LLM call + parsing
  // ═══════════════════════════════════════════════════════
  const gapSpan = startSpan('skill_gap.generate');
  setAttr(gapSpan, 'org_id', orgId);
  setAttr(gapSpan, 'learner_id', learnerId);
  setAttr(gapSpan, 'skill_count', profile.skills.length);
  setAttr(gapSpan, 'gap_candidates', gapEntries.length);

  try {
    // ── Call AI03 Gateway ──
    const gwSpan = startSpan('ai_gateway.generate');
    setAttr(gwSpan, 'tier', 'standard');

    const result = await callGateway(env.AI_GATEWAY, prompt, orgId);

    setAttr(gwSpan, 'status', result ? 200 : 502);
    endSpan(gwSpan);

    if (!result) {
      setAttr(gapSpan, 'ai_gateway_error', true);
      setAttr(gapSpan, 'ai_status', 'degraded');
      endSpan(gapSpan);
      return json(placeholderResponse(), 200);
    }

    setAttr(gapSpan, 'llm_model', result.model);
    setAttr(gapSpan, 'llm_tokens', result.tokens);

    const parsed = parseGapAnalysis(result.text, profile.skills, gapMap);

    setAttr(gapSpan, 'ai_status', 'generated');
    setAttr(gapSpan, 'gap_count', parsed.gaps.length);
    setAttr(gapSpan, 'summary_length', parsed.summary.length);
    endSpan(gapSpan);

    return json(parsed, 200);
  } catch (err: any) {
    setAttr(gapSpan, 'ai_gateway_error', true);
    setAttr(gapSpan, 'ai_status', 'degraded');
    setAttr(gapSpan, 'error', err.message);
    endSpan(gapSpan);
    return json(placeholderResponse(), 200);
  }
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildPrompt(
  profile: LearnerProfile,
  gaps: { skill: string; courses_available: number; estimated_hours: number }[],
  catalogue: CatalogueCourse[],
  progress: ProgressEntry[],
): string {
  const learnerSkills = profile.skills.join(', ');
  const goals = profile.goals || '(no goals set)';
  const level = profile.experience_level;

  const gapLines = gaps.map((g) =>
    `  - ${g.skill}: ${g.courses_available} courses available, ~${g.estimated_hours}h estimated`
  ).join('\n');

  // Show relevant courses for gaps
  const gapSkills = new Set(gaps.map((g) => g.skill));
  const completedSet = completedTitleSet(progress);
  const relevantCourses = catalogue.filter((c) => {
    const title = c.title?.toLowerCase().trim() || '';
    if (completedSet.has(title)) return false;
    return (c.prerequisites || []).some((p) => gapSkills.has(p.toLowerCase().trim()));
  });
  const courseLines = relevantCourses.slice(0, 10).map((c) =>
    `  - "${c.title}" (${c.difficulty}, category: ${c.category || 'general'})`
  ).join('\n');

  const completedLines = progress
    .filter((p) => p.status === 'completed')
    .slice(0, 5)
    .map((p) => `  - ${p.title}`)
    .join('\n');

  const inProgressLines = progress
    .filter((p) => p.status === 'in_progress')
    .slice(0, 5)
    .map((p) => `  - ${p.title} (${p.progress_pct}%)`)
    .join('\n');

  return [
    `You are a career coach analyzing skill gaps for a learner.`,
    ``,
    `LEARNER PROFILE:`,
    `  Skills: ${learnerSkills || '(none listed)'}`,
    `  Goals: ${goals}`,
    `  Experience level: ${level}`,
    ``,
    `COMPLETED COURSES:`,
    completedLines || '  (none)',
    ``,
    `IN-PROGRESS COURSES:`,
    inProgressLines || '  (none)',
    ``,
    `IDENTIFIED GAPS (skills the learner lacks but are required by available courses):`,
    gapLines || '  (no significant gaps found)',
    ``,
    `RELEVANT COURSES (that require skills the learner doesn't have yet):`,
    courseLines || '  (none directly matching gaps)',
    ``,
    `TASK:`,
    `1. Analyze the learner's current skills against what the course catalog requires.`,
    `2. For each gap, estimate the proficiency level required (beginner/intermediate/advanced).`,
    `3. Recommend 3-5 skills to focus on, prioritizing by:`,
    `   a) Skills required by the most courses`,
    `   b) Skills aligned with the learner's stated goals`,
    `   c) Foundation skills before advanced ones`,
    `4. Write a brief, encouraging summary (1-2 sentences) highlighting the biggest opportunity area.`,
    `5. Be specific about which skills to learn and why they matter for the learner's goals.`,
    ``,
    `RULES:`,
    `- Current level for gaps is "none" unless the learner has that skill listed.`,
    `- Required level based on course difficulty: beginner courses → beginner, intermediate → intermediate, advanced → advanced.`,
    `- Estimated hours per skill: 10h (beginner), 20h (intermediate), 40h (advanced).`,
    `- Be encouraging, never discouraging.`,
    `- If learner has no skills, the prompt should ask them to add skills to their profile.`,
    ``,
    `Return a JSON object. No other text.`,
    `Format: {"gaps":[{"skill":"spark","current_level":"none","required_level":"intermediate","courses_available":3,"estimated_hours":40}],"summary":"<1-2 sentence encouraging summary>"}`,
  ].join('\n');
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

function parseGapAnalysis(
  response: string,
  learnerSkills: string[],
  gapMap: Map<string, CatalogueCourse[]>,
): SkillGapResponse {
  // Extract JSON from response (LLM may wrap in markdown code blocks)
  const codeBlock = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlock ? codeBlock[1] : response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonStr) {
    return {
      learner_skills: learnerSkills,
      gaps: [],
      summary: response.slice(0, 500) || 'Skill gap analysis unavailable right now — check back shortly.',
      ai_status: 'degraded',
    };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const rawGaps: any[] = parsed.gaps || [];

    // Enrich gaps with computed data where LLM was inaccurate
    const gaps: SkillGap[] = rawGaps.map((g: any) => {
      const skillLower = (g.skill || '').toLowerCase().trim();
      const computedCourses = gapMap.get(skillLower);
      const coursesAvailable = computedCourses ? computedCourses.length : (g.courses_available || 0);
      // Compute estimated hours from actual matched courses
      const estimatedHours = (computedCourses && computedCourses.length > 0)
        ? estimateHoursForCourses(computedCourses)
        : g.estimated_hours || 10;
      return {
        skill: g.skill || skillLower,
        current_level: g.current_level || 'none',
        required_level: g.required_level || 'beginner',
        courses_available: coursesAvailable,
        estimated_hours: estimatedHours,
      };
    });

    return {
      learner_skills: learnerSkills,
      gaps,
      summary: parsed.summary || 'Review your skill gaps to find the best next steps.',
      ai_status: 'generated',
    };
  } catch {
    return {
      learner_skills: learnerSkills,
      gaps: [],
      summary: response.slice(0, 500) || 'Skill gap analysis unavailable right now — check back shortly.',
      ai_status: 'degraded',
    };
  }
}

// ════════════════════════════════════════════════════════
//  Placeholder Response (degraded mode)
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

/** Estimate average hours for a set of courses based on difficulty. */
function estimateHoursForCourses(courses: CatalogueCourse[]): number {
  if (courses.length === 0) return 10;
  const totalHours = courses.reduce((sum, c) => {
    const diff = (c.difficulty || 'beginner').toLowerCase();
    return sum + (HOURS_BY_DIFFICULTY[diff] || 10);
  }, 0);
  return Math.round(totalHours / courses.length);
}

/** Build a set of completed course titles (lowercased) from progress entries. */
function completedTitleSet(progress: ProgressEntry[]): Set<string> {
  return new Set(
    progress
      .filter((p) => p.status === 'completed')
      .map((p) => p.title.toLowerCase().trim()),
  );
}

// ════════════════════════════════════════════════════════
//  Placeholder Response (degraded mode)
// ════════════════════════════════════════════════════════

function placeholderResponse(): SkillGapResponse {
  return {
    learner_skills: [],
    gaps: [],
    summary: 'Skill gap analysis unavailable right now — check back shortly.',
    ai_status: 'degraded',
  };
}
