// ============================================================
// F03a: Skill-Gap Analysis (Mentor Worker)
// ============================================================
// Compares learner's current skills against course catalogue
// skill requirements. Identifies gaps and recommends courses
// with estimated effort. Calls AI03 Gateway (standard tier).
// ============================================================

import { json, handleCors } from "../../shared/cors";
import { startSpan, setAttr, endSpan, type SpanContext } from "../../shared/observability";
import { fetchProfile, fetchCatalog, fetchProgress, type LearnerProfile, type CatalogueCourse, type ProgressEntry } from "../../shared/lms-data";
import { callGateway } from "../../shared/gateway";
import { parseLlmJson } from "../../shared/llm-parser";
import type { BaseEnv } from "../../shared/env";

export interface Env extends BaseEnv {}

// ──── Types ────

type StubProfile = Partial<LearnerProfile>;
type StubCourse = Partial<CatalogueCourse>;
type StubProgress = Partial<ProgressEntry>;

interface SkillGapRequest {
  learner_id: string;
  org_id: string;
  // ── Stub mode: provide data directly when LMS is unavailable ──
  profile?: StubProfile;
  catalogue?: StubCourse[];
  progress?: StubProgress[];
}

interface GapEntry {
  skill: string;
  current_level: string;
  required_level: string;
  courses_available: number;
  estimated_hours: number;
}

interface SkillGapResponse {
  learner_skills: string[];
  gaps: GapEntry[];
  summary: string;
}

type AiStatus = "generated" | "no_skills" | "degraded";

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // ── CORS preflight ──
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    if (url.pathname !== "/mentor/skill-gap") {
      return json({ error: "Not found" }, 404);
    }

    // ── GET: query params | POST: JSON body (may carry stub data) ──
    let body: SkillGapRequest;
    if (req.method === "GET") {
      body = {
        learner_id: url.searchParams.get("learner_id") || "",
        org_id: url.searchParams.get("org_id") || "",
      };
    } else if (req.method === "POST") {
      try {
        body = await req.json() as SkillGapRequest;
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
    } else {
      return json({ error: "Method not allowed" }, 405);
    }

    return handleSkillGap(body, env);
  },
};

// ════════════════════════════════════════════════════════
//  GET|POST /mentor/skill-gap
// ════════════════════════════════════════════════════════

async function handleSkillGap(
  body: SkillGapRequest,
  env: Env
): Promise<Response> {
  // ── Validation ──
  if (!body.learner_id) {
    return json({ error: "missing_field: learner_id" }, 400);
  }
  if (!body.org_id) {
    return json({ error: "missing_field: org_id" }, 400);
  }

  // ═══════════════════════════════════════════════════════
  //  SPAN: data.fetch — gather learner data
  // ═══════════════════════════════════════════════════════
  const dataSpan = startSpan("data.fetch");
  setAttr(dataSpan, "learner_id", body.learner_id);
  setAttr(dataSpan, "org_id", body.org_id);

  // ── Fetch learner profile ──
  const profileSpan = startSpan("lms.fetch");
  setAttr(profileSpan, "endpoint", "profile");
  setAttr(profileSpan, "learner_id", body.learner_id);
  const { profile: lmsProfile, fromLms: profileFromLms } = await fetchProfile(env, body.profile, body.learner_id);
  setAttr(profileSpan, "status", profileFromLms ? 200 : "stub");
  endSpan(profileSpan);

  // ── Fetch course catalogue ──
  const catalogSpan = startSpan("lms.fetch");
  setAttr(catalogSpan, "endpoint", "catalog");
  setAttr(catalogSpan, "org_id", body.org_id);
  const { catalogue, fromLms: catalogFromLms } = await fetchCatalog(env, body.org_id, body.catalogue);
  setAttr(catalogSpan, "status", catalogFromLms ? 200 : "stub");
  setAttr(catalogSpan, "course_count", catalogue.length);
  endSpan(catalogSpan);

  // ── Fetch learner progress ──
  const progressSpan = startSpan("lms.fetch");
  setAttr(progressSpan, "endpoint", "progress");
  setAttr(progressSpan, "learner_id", body.learner_id);
  const { progress, fromLms: progressFromLms } = await fetchProgress(env, body.learner_id, body.progress);
  setAttr(progressSpan, "status", progressFromLms ? 200 : "stub");
  setAttr(progressSpan, "enrollment_count", progress.length);
  endSpan(progressSpan);

  const hasSkills = !!(lmsProfile.skills && lmsProfile.skills.length > 0);
  setAttr(dataSpan, "profile_from_lms", profileFromLms);
  setAttr(dataSpan, "catalog_from_lms", catalogFromLms);
  setAttr(dataSpan, "progress_from_lms", progressFromLms);
  setAttr(dataSpan, "catalogue_courses", catalogue.length);
  setAttr(dataSpan, "progress_entries", progress.length);
  setAttr(dataSpan, "has_skills", hasSkills);
  endSpan(dataSpan);

  // ── No skills → return guidance ──
  if (!hasSkills) {
    return json({
      learner_skills: [],
      gaps: [],
      summary: "No skills found on your profile. Please add your skills to get a personalized gap analysis.",
    }, 200);
  }

  // ── No catalogue → no analysis possible ──
  if (catalogue.length === 0) {
    return json({
      learner_skills: lmsProfile.skills,
      gaps: [],
      summary: "No courses available in the catalogue to analyze gaps against.",
    }, 200);
  }

  // ── Build prompt ──
  const learnerSkills = lmsProfile.skills;
  const prompt = buildPrompt(lmsProfile, catalogue, progress);

  // ═══════════════════════════════════════════════════════
  //  SPAN: gap.analyze — LLM call + validation
  // ═══════════════════════════════════════════════════════
  const gapSpan = startSpan("gap.analyze");
  setAttr(gapSpan, "org_id", body.org_id);
  setAttr(gapSpan, "catalogue_courses_considered", catalogue.length);
  setAttr(gapSpan, "learner_skill_count", learnerSkills.length);
  setAttr(gapSpan, "has_profile_goals", !!lmsProfile.goals);

  try {
    // ── Call AI03 Gateway ──
    const gatewayReqSpan = startSpan("ai_gateway.generate");
    setAttr(gatewayReqSpan, "tier", "standard");

    const result = await callGateway(env.AI_GATEWAY, prompt, body.org_id);

    setAttr(gatewayReqSpan, "status", result ? 200 : 502);
    endSpan(gatewayReqSpan);

    if (!result) {
      setAttr(gapSpan, "ai_gateway_error", true);
      setAttr(gapSpan, "ai_status", "degraded");
      setAttr(gapSpan, "gap_count", 0);
      endSpan(gapSpan);

      return json({
        learner_skills: learnerSkills,
        gaps: computeFallbackGaps(learnerSkills, catalogue, progress),
        summary: "Gap analysis is currently unavailable. Showing catalogue suggestions.",
      }, 200);
    }

    setAttr(gapSpan, "llm_model", result.model);
    setAttr(gapSpan, "llm_tokens", result.tokens);

    const gapResult = parseGapResponse(result.text, learnerSkills, gapSpan);
    const isFallback = !gapResult.fromLlm;

    setAttr(gapSpan, "ai_status", isFallback ? "degraded" : "generated");
    setAttr(gapSpan, "gap_count", gapResult.gaps.length);
    setAttr(gapSpan, "summary_length", gapResult.summary.length);
    endSpan(gapSpan);

    return json({
      learner_skills: learnerSkills,
      gaps: gapResult.gaps,
      summary: gapResult.summary,
    }, 200);
  } catch (err: any) {
    setAttr(gapSpan, "error", err.message);
    setAttr(gapSpan, "ai_status", "degraded");
    setAttr(gapSpan, "gap_count", 0);
    endSpan(gapSpan);

    return json({
      learner_skills: learnerSkills,
      gaps: computeFallbackGaps(learnerSkills, catalogue, progress),
      summary: "Gap analysis is currently unavailable. Showing catalogue suggestions.",
    }, 200);
  }
}

// ════════════════════════════════════════════════════════
//  Prompt Builder
// ════════════════════════════════════════════════════════

function buildPrompt(
  profile: LearnerProfile,
  catalogue: CatalogueCourse[],
  progress: ProgressEntry[]
): string {
  const skills = profile.skills?.join(", ") || "none listed";
  const goals = profile.goals || "none listed";
  const experience = profile.experience_level || "beginner";

  const completed = progress
    .filter((p) => p.status === "completed")
    .map((p) => p.title);

  const inProgress = progress
    .filter((p) => p.status === "in_progress")
    .map((p) => `${p.title} (${p.progress_pct || 0}% done)`);

  const catalogueList = catalogue
    .map((c) => {
      const prereq = c.prerequisites?.length
        ? ` [prerequisites: ${c.prerequisites.join(", ")}]`
        : "";
      return `- ${c.title} (difficulty: ${c.difficulty || "unknown"}, category: ${c.category || "general"})${prereq}`;
    })
    .join("\n");

  return [
    "You are a skill-gap analyst. Compare a learner's current skills against the available course catalogue and identify what skills they're missing.",
    "",
    "LEARNER PROFILE:",
    `  Skills: ${skills}`,
    `  Goals: ${goals}`,
    `  Experience level: ${experience}`,
    "",
    `Completed courses: ${completed.length ? completed.join(", ") : "none"}`,
    `In-progress: ${inProgress.length ? inProgress.join(", ") : "none"}`,
    "",
    "AVAILABLE COURSES (infer required skills from titles, categories, and difficulty):",
    catalogueList,
    "",
    "INSTRUCTIONS:",
    "1. From the course catalogue, infer what skills are required to succeed in the courses.",
    "2. Compare those required skills against the learner's current skills.",
    "3. Identify gaps — skills the learner doesn't have or needs to improve.",
    "4. For each gap, estimate the effort (hours) based on course difficulty.",
    "5. Count how many courses in the catalogue relate to each gap skill.",
    "6. Write a concise, encouraging summary (2-3 sentences).",
    "",
    "PROFICIENCY LEVELS: Use none, beginner, intermediate, advanced.",
    "",
    "Return a JSON object with 'gaps' array and 'summary' string. No other text.",
    'Example: {"gaps":[{"skill":"spark","current_level":"none","required_level":"intermediate","courses_available":2,"estimated_hours":40}],"summary":"Strong in Python and SQL. Biggest gap is distributed computing."}',
  ].join("\n");
}

// ════════════════════════════════════════════════════════
//  Response Parser
// ════════════════════════════════════════════════════════

interface ParsedGapResult {
  gaps: GapEntry[];
  summary: string;
  fromLlm: boolean;
}

function parseGapResponse(
  response: string,
  learnerSkills: string[],
  gapSpan: SpanContext,
): ParsedGapResult {
  const parsed = parseLlmJson<{ gaps?: any[]; summary?: string }>(response);
  if (!parsed) {
    setAttr(gapSpan, "parse_failed", true);
    return { gaps: [], summary: "Gap analysis is currently unavailable.", fromLlm: false };
  }

  const rawGaps: any[] = parsed.gaps || [];
  setAttr(gapSpan, "llm_returned_gaps", rawGaps.length);

  const gaps: GapEntry[] = rawGaps.map((g: any) => ({
    skill: g.skill || "unknown",
    current_level: g.current_level || "none",
    required_level: g.required_level || "beginner",
    courses_available: typeof g.courses_available === "number" ? g.courses_available : 0,
    estimated_hours: typeof g.estimated_hours === "number" ? g.estimated_hours : 0,
  }));

  const summary = typeof parsed.summary === "string" && parsed.summary.length > 0
    ? parsed.summary
    : `Identified ${gaps.length} skill gaps based on your profile and available courses.`;

  return { gaps, summary, fromLlm: true };
}

// ════════════════════════════════════════════════════════
//  Fallback Gap Computation (no LLM)
// ════════════════════════════════════════════════════════

function computeFallbackGaps(
  learnerSkills: string[],
  catalogue: CatalogueCourse[],
  progress: ProgressEntry[],
): GapEntry[] {
  const learnerSkillSet = new Set(learnerSkills.map((s) => s.toLowerCase()));
  const completedTitles = new Set(
    progress.filter((p) => p.status === "completed").map((p) => p.title.toLowerCase()),
  );

  // Build map: inferred skill → courses that teach it
  const skillCourses = new Map<string, CatalogueCourse[]>();
  const difficultyHours: Record<string, number> = {
    beginner: 10,
    intermediate: 30,
    advanced: 60,
  };

  for (const course of catalogue) {
    if (completedTitles.has(course.title.toLowerCase())) continue;

    // Infer skills from category and title
    const inferredSkills = inferSkillsFromCourse(course);
    for (const skill of inferredSkills) {
      const key = skill.toLowerCase();
      if (!skillCourses.has(key)) skillCourses.set(key, []);
      skillCourses.get(key)!.push(course);
    }
  }

  // Find gaps: inferred skills not in learner's skill set
  const gaps: GapEntry[] = [];
  for (const [skill, courses] of skillCourses) {
    if (learnerSkillSet.has(skill)) continue;

    const totalHours = courses.reduce((sum, c) => {
      return sum + (difficultyHours[c.difficulty] || 20);
    }, 0);

    gaps.push({
      skill,
      current_level: "none",
      required_level: inferRequiredLevel(courses),
      courses_available: courses.length,
      estimated_hours: Math.round(totalHours / courses.length) * courses.length,
    });
  }

  // Sort by courses_available descending (biggest gaps first)
  gaps.sort((a, b) => b.courses_available - a.courses_available);
  return gaps.slice(0, 8);
}

/** Infer skill names from a course's category and title. */
function inferSkillsFromCourse(course: CatalogueCourse): string[] {
  const skills = new Set<string>();

  // Category-to-skill mapping
  const categorySkills: Record<string, string> = {
    "programming": "programming",
    "python": "python",
    "data-science": "data science",
    "data-engineering": "data engineering",
    "ai-ml": "machine learning",
    "machine-learning": "machine learning",
    "deep-learning": "deep learning",
    "sql": "sql",
    "database": "databases",
    "cloud": "cloud computing",
    "devops": "devops",
    "web-dev": "web development",
    "cybersecurity": "cybersecurity",
    "networking": "networking",
    "math": "mathematics",
    "statistics": "statistics",
  };

  if (course.category) {
    const lower = course.category.toLowerCase();
    if (categorySkills[lower]) {
      skills.add(categorySkills[lower]);
    }
  }

  // Title keyword extraction
  const titleKeywords: [RegExp, string][] = [
    [/python/i, "python"],
    [/spark/i, "spark"],
    [/sql/i, "sql"],
    [/machine learning/i, "machine learning"],
    [/deep learning/i, "deep learning"],
    [/data science/i, "data science"],
    [/data engineering/i, "data engineering"],
    [/javascript/i, "javascript"],
    [/typescript/i, "typescript"],
    [/java\b/i, "java"],
    [/golang|go\s*lang/i, "go"],
    [/rust/i, "rust"],
    [/kubernetes/i, "kubernetes"],
    [/docker/i, "docker"],
    [/aws/i, "aws"],
    [/azure/i, "azure"],
    [/react/i, "react"],
    [/angular/i, "angular"],
    [/vue/i, "vue"],
    [/node\.?js/i, "node.js"],
    [/tensorflow/i, "tensorflow"],
    [/pytorch/i, "pytorch"],
    [/nlp/i, "nlp"],
    [/excel/i, "excel"],
    [/power\s*bi/i, "power bi"],
    [/tableau/i, "tableau"],
  ];

  for (const [regex, skill] of titleKeywords) {
    if (regex.test(course.title)) {
      skills.add(skill);
    }
  }

  // Fallback: use category as skill
  if (skills.size === 0 && course.category) {
    skills.add(course.category);
  }

  return [...skills];
}

/** Infer required proficiency level from the most common difficulty in the course list. */
function inferRequiredLevel(courses: CatalogueCourse[]): string {
  const counts: Record<string, number> = {};
  for (const c of courses) {
    const d = c.difficulty || "intermediate";
    counts[d] = (counts[d] || 0) + 1;
  }
  let best = "intermediate";
  let bestCount = 0;
  for (const [level, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = level;
      bestCount = count;
    }
  }
  return best;
}
