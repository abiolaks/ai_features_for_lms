// ============================================================
// AI06: Personalized Learning Paths
// ============================================================
// Generates an AI-personalized, ordered learning path based on
// learner profile, progress, and available course catalogue.
// Calls AI03 Gateway (service binding) with a curriculum
// design prompt.
// ============================================================

import { fetchLms } from "../../shared/fetch-lms";
import { json, handleCors } from "../../shared/cors";
import { startSpan, setAttr, endSpan, type SpanContext } from "../../shared/observability";
import { fetchProfile, fetchCatalog, fetchProgress, type LearnerProfile, type CatalogueCourse, type ProgressEntry } from "../../shared/lms-data";
import { callGateway } from "../../shared/gateway";
import { parseLlmJson } from "../../shared/llm-parser";
import type { BaseEnv } from "../../shared/env";

export interface Env extends BaseEnv {}

// ──── Types ────

/** Stub types accept partial data for offline/degraded mode. */
type StubProfile = Partial<LearnerProfile>;
type StubCourse = Partial<CatalogueCourse>;
type StubProgress = Partial<ProgressEntry>;

interface PathRequest {
  learner_id: string;
  org_id: string;
  // ── Stub mode: provide data directly when LMS is unavailable ──
  profile?: StubProfile;
  catalogue?: StubCourse[];
  progress?: StubProgress[];
}

interface PathCourse {
  course_title: string;
  order: number;
  why_this_fits: string;
}

interface PathResponse {
  path: PathCourse[];
  ai_status: "generated" | "insufficient_data" | "degraded";
}

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // ── CORS preflight ──
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);

    // GET /diag-catalog — diagnostic: check what LMS returns
    if (req.method === "GET" && url.pathname === "/diag-catalog") {
      try {
        const resp = await fetchLms(env, { path: `/api/v1/catalog` });
        const text = await resp.text();
        return json({ status: resp.status, ok: resp.ok, body: text.substring(0, 500) });
      } catch (e: any) {
        return json({ error: e.message });
      }
    }

    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname !== "/paths/generate") {
      return json({ error: "Not found" }, 404);
    }

    let body: PathRequest;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    return handleGenerate(body, env);
  },
};

// ════════════════════════════════════════════════════════
//  POST /paths/generate
// ════════════════════════════════════════════════════════

async function handleGenerate(
  body: PathRequest,
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
  const { profile: lmsProfile, fromLms: profileFromLms } = await fetchProfile(env, body.profile);
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

  setAttr(dataSpan, "profile_from_lms", profileFromLms);
  setAttr(dataSpan, "catalog_from_lms", catalogFromLms);
  setAttr(dataSpan, "progress_from_lms", progressFromLms);
  setAttr(dataSpan, "catalogue_courses", catalogue.length);
  setAttr(dataSpan, "progress_entries", progress.length);
  setAttr(dataSpan, "has_profile", !!(lmsProfile.skills.length || lmsProfile.goals));
  endSpan(dataSpan);

  // ── Insufficient data check ──
  if (catalogue.length === 0) {
    return json({
      path: [],
      ai_status: "insufficient_data",
    }, 200);
  }

  const hasProfile = lmsProfile && (lmsProfile.skills.length || lmsProfile.goals);
  if (!hasProfile) {
    return json({
      path: catalogue.slice(0, 5).map((c, i) => ({
        course_title: c.title,
        order: i + 1,
        why_this_fits: "Add skills and goals to get personalized recommendations.",
      })),
      ai_status: "insufficient_data",
    }, 200);
  }

  // ── Build prompt ──
  const learnerProfile = lmsProfile;
  const prompt = buildPrompt(learnerProfile, catalogue, progress);

  // ═══════════════════════════════════════════════════════
  //  SPAN: path.generate — LLM call + validation
  // ═══════════════════════════════════════════════════════
  const pathSpan = startSpan("path.generate");
  setAttr(pathSpan, "org_id", body.org_id);
  setAttr(pathSpan, "catalogue_courses_considered", catalogue.length);
  setAttr(pathSpan, "completed_courses", progress.filter((p) => p.status === "completed").length);
  setAttr(pathSpan, "has_profile_goals", !!learnerProfile.goals);
  setAttr(pathSpan, "has_profile_skills", !!(learnerProfile.skills && learnerProfile.skills.length > 0));

  try {
    // ── Call AI03 Gateway ──
    const gatewayReqSpan = startSpan("ai_gateway.generate");
    setAttr(gatewayReqSpan, "tier", "standard");

    const result = await callGateway(env.AI_GATEWAY, prompt, body.org_id);

    setAttr(gatewayReqSpan, "status", result ? 200 : 502);
    endSpan(gatewayReqSpan);

    if (!result) {
      setAttr(pathSpan, "ai_gateway_error", true);
      setAttr(pathSpan, "ai_status", "degraded");
      setAttr(pathSpan, "course_count", 0);
      setAttr(pathSpan, "why_this_fits_count", 0);
      setAttr(pathSpan, "prereq_violations", 0);
      endSpan(pathSpan);

      return json({
        path: fallbackPath(catalogue, progress),
        ai_status: "degraded",
      }, 200);
    }

    setAttr(pathSpan, "llm_model", result.model);
    setAttr(pathSpan, "llm_tokens", result.tokens);

    // Normalize: Workers AI sometimes returns response as already-parsed object
    const responseText = result.text;

    const path = parsePath(responseText, catalogue, progress, pathSpan);
    const isFallback = path.length > 0 && path.every((c) => !c.why_this_fits);

    setAttr(pathSpan, "ai_status", isFallback ? "degraded" : "generated");
    setAttr(pathSpan, "course_count", path.length);
    setAttr(pathSpan, "why_this_fits_count", path.filter((c) => !!c.why_this_fits).length);
    endSpan(pathSpan);

    return json({
      path,
      ai_status: isFallback ? "degraded" : "generated",
    }, 200);
  } catch (err: any) {
    setAttr(pathSpan, "error", err.message);
    setAttr(pathSpan, "ai_status", "degraded");
    setAttr(pathSpan, "course_count", 0);
    setAttr(pathSpan, "why_this_fits_count", 0);
    setAttr(pathSpan, "prereq_violations", 0);
    endSpan(pathSpan);

    return json({
      path: fallbackPath(catalogue, progress),
      ai_status: "degraded",
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
  const completed = progress
    .filter((p) => p.status === "completed")
    .map((p) => p.title);

  const inProgress = progress
    .filter((p) => p.status === "in_progress")
    .map((p) => `${p.title} (${p.progress_pct || 0}% done)`);

  const skills = profile.skills?.join(", ") || "none listed";
  const goals = profile.goals || "none listed";
  const experience = profile.experience_level || "beginner";

  const catalogueList = catalogue
    .map((c) => {
      const prereq = c.prerequisites?.length
        ? ` [prerequisites: ${c.prerequisites.join(", ")}]`
        : "";
      return `- ${c.title} (difficulty: ${c.difficulty || "unknown"}, category: ${c.category || "general"})${prereq}`;
    })
    .join("\n");

  return [
    "You are a curriculum designer. Generate a personalized learning path.",
    "",
    "LEARNER PROFILE:",
    `  Skills: ${skills}`,
    `  Goals: ${goals}`,
    `  Experience: ${experience}`,
    `  Streak: ${profile.streak_days || 0} days`,
    "",
    `Completed courses: ${completed.length ? completed.join(", ") : "none"}`,
    `In-progress: ${inProgress.length ? inProgress.join(", ") : "none"}`,
    "",
    "AVAILABLE COURSES:",
    catalogueList,
    "",
    "INSTRUCTIONS:",
    "1. Generate an ordered path of 3-5 courses.",
    "2. Exclude completed courses.",
    "3. Place prerequisites before their dependents.",
    "4. For each course, write a one-sentence explanation of why it fits.",
    "",
    "Return a JSON object with a 'courses' array. No other text.",
    'Example: {"courses":[{"course_title":"X","order":1,"why_this_fits":"Y"}]}',
  ].join("\n");
}

// ════════════════════════════════════════════════════════
//  Response Parser & Validator
// ════════════════════════════════════════════════════════

function parsePath(
  response: string,
  catalogue: CatalogueCourse[],
  progress: ProgressEntry[],
  pathSpan: SpanContext,
): PathCourse[] {
  const parsed = parseLlmJson<{ courses?: any[]; path?: any[] }>(response);
  if (!parsed) {
    setAttr(pathSpan, "parse_failed", true);
    return fallbackPath(catalogue);
  }

  const rawList = parsed.courses || parsed.path || [];
  setAttr(pathSpan, "llm_returned_courses", rawList.length);
  let courses: PathCourse[] = rawList.map((c: any, i: number) => ({
    course_title: c.course_title || c.title || "Unknown",
    order: c.order || i + 1,
    why_this_fits: c.why_this_fits || c.reason || c.explanation || "",
  }));

  // Safety: filter out completed courses
  const completedTitles = new Set(
    progress.filter((p) => p.status === "completed").map((p) => p.title)
  );
  const beforeFilter = courses.length;
  courses = courses.filter((c) => !completedTitles.has(c.course_title));
  const completedFiltered = beforeFilter - courses.length;
  setAttr(pathSpan, "completed_courses_filtered_out", completedFiltered);

  // Validate prerequisites ordering
  // Completed courses satisfy prerequisites automatically
  const catMap = new Map(catalogue.map((c) => [c.title, c]));
  const seen = new Set<string>(completedTitles);
  let prereqViolations = 0;

  courses = courses.filter((c) => {
    const meta = catMap.get(c.course_title);
    if (!meta?.prerequisites?.length) {
      seen.add(c.course_title);
      return true;
    }

    // All prerequisites must appear before this course (or be completed)
    const prereqsSatisfied = meta.prerequisites.every((p) => seen.has(p));
    if (!prereqsSatisfied) prereqViolations++;
    if (prereqsSatisfied) seen.add(c.course_title);
    return prereqsSatisfied;
  });

  setAttr(pathSpan, "prereq_violations", prereqViolations);

  // Limit to 5 courses
  return courses.slice(0, 5);
}

function fallbackPath(
  catalogue: CatalogueCourse[],
  progress: ProgressEntry[] = []
): PathCourse[] {
  const completedTitles = new Set(
    progress.filter((p) => p.status === "completed").map((p) => p.title)
  );
  return catalogue
    .filter((c) => !completedTitles.has(c.title))
    .slice(0, 5)
    .map((c, i) => ({
      course_title: c.title,
      order: i + 1,
      why_this_fits: "",
    }));
}


