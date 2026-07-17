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

export interface Env {
  AI_GATEWAY: Fetcher;
  LMS_GATEWAY_URL: string;
  LMS_INTERNAL_KEY: string;
}

// ──── Types ────

interface LearnerProfile {
  skills?: string[];
  goals?: string;
  experience_level?: string;
  interests?: string[];
  streak_days?: number;
  points?: number;
}

interface CatalogueCourse {
  title: string;
  difficulty?: string;
  category?: string;
  prerequisites?: string[];
}

interface ProgressEntry {
  title: string;
  status: "completed" | "in_progress";
  progress_pct?: number;
}

interface PathRequest {
  learner_id: string;
  org_id: string;
  // ── Stub mode: provide data directly until LMS APIs exist ──
  profile?: LearnerProfile;
  catalogue?: CatalogueCourse[];
  progress?: ProgressEntry[];
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
//  Span Helpers (Cloudflare Workers Observability)
// ════════════════════════════════════════════════════════
//
// Workers built-in observability captures top-level request spans.
// We add structured console.log for custom sub-spans, surfaced
// via wrangler tail / Workers Logs / Analytics Engine.
// ============================================================

interface SpanContext {
  name: string;
  attrs: Record<string, unknown>;
  startMs: number;
}

function startSpan(name: string): SpanContext {
  return { name, attrs: {}, startMs: Date.now() };
}

function setAttr(ctx: SpanContext, key: string, value: unknown): void {
  ctx.attrs[key] = value;
}

function endSpan(ctx: SpanContext): void {
  const duration = Date.now() - ctx.startMs;
  console.log(
    JSON.stringify({
      span: ctx.name,
      duration_ms: duration,
      ...ctx.attrs,
    })
  );
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

  // ── LMS: Fetch learner profile ──
  let profile = body.profile;
  let profileFromLms = false;
  try {
    const profileSpan = startSpan("lms.fetch");
    setAttr(profileSpan, "endpoint", "profile");
    setAttr(profileSpan, "learner_id", body.learner_id);
    const resp = await fetchLms(env, {
      path: `/api/v1/learner/profile`,
    });
    setAttr(profileSpan, "status", resp.status);
    if (resp.ok) {
      const raw = await resp.json() as any;
      const data = raw.data || raw;
      const lmsProfile = {
        skills: data.skills || [],
        goals: data.goals || "",
        experience_level: data.experience_level || "beginner",
        interests: data.interests || [],
        streak_days: data.gamification?.login_streak || 0,
        points: data.gamification?.total_points || 0,
      };
      // Only use LMS profile if it has actual data
      if (lmsProfile.skills.length > 0 || lmsProfile.goals) {
        profile = lmsProfile;
      }
      profileFromLms = true;
    }
    endSpan(profileSpan);
  } catch {
    // LMS not available — use stub data from request body
    setAttr(dataSpan, "lms_available", false);
  }

  // ── LMS: Fetch course catalogue ──
  let catalogue = body.catalogue || [];
  let catalogFromLms = false;
  try {
    const catalogSpan = startSpan("lms.fetch");
    setAttr(catalogSpan, "endpoint", "catalog");
    setAttr(catalogSpan, "org_id", body.org_id);
    
    // Try authenticated catalog first, fall back to public if empty
    let resp = await fetchLms(env, { path: `/api/v1/catalog?organization_id=${body.org_id}` });
    setAttr(catalogSpan, "status", resp.status);
    
    if (resp.ok) {
      const raw = await resp.json() as any;
      const items = raw.data || raw;
      // If authenticated catalog is empty, try public endpoint
      if (!items || items.length === 0) {
        resp = await fetchLms(env, { path: `/api/v1/public/courses` });
        if (resp.ok) {
          const publicRaw = await resp.json() as any;
          const publicItems = publicRaw.data || publicRaw;
          if (publicItems && publicItems.length > 0) {
            const lmsCourses = publicItems.map((c: any) => ({
              title: c.title,
              difficulty: c.difficultyLevel || c.difficulty,
              category: c.category,
              prerequisites: c.prerequisites || [],
            }));
            catalogue = lmsCourses;
            catalogFromLms = true;
          }
        }
      } else {
        const lmsCourses = items.map((c: any) => ({
          title: c.title,
          difficulty: c.difficultyLevel || c.difficulty,
          category: c.category,
          prerequisites: c.prerequisites || [],
        }));
        catalogue = lmsCourses;
        catalogFromLms = true;
      }
    }
    setAttr(catalogSpan, "course_count", catalogue.length);
    endSpan(catalogSpan);
  } catch {
    // LMS not available — use stub data from request body
  }

  // ── LMS: Fetch learner progress ──
  let progress = body.progress || [];
  let progressFromLms = false;
  try {
    const progressSpan = startSpan("lms.fetch");
    setAttr(progressSpan, "endpoint", "progress");
    setAttr(progressSpan, "learner_id", body.learner_id);
    const resp = await fetchLms(env, {
      path: `/api/v1/progress/user?userId=${body.learner_id}`,
    });
    setAttr(progressSpan, "status", resp.status);
    if (resp.ok) {
      const raw = await resp.json() as any;
      const data = raw.data || raw;
      const enrollments = data.enrollments || [];
      const lmsProgress = enrollments.map((e: any) => ({
        title: e.courseTitle,
        status: e.status === "completed" ? "completed" : "in_progress",
        progress_pct: parseInt(e.progressPercent) || 0,
      }));
      // Only use LMS data if it returned progress; otherwise keep stub data
      if (lmsProgress.length > 0) {
        progress = lmsProgress;
      }
      progressFromLms = true;
    }
    setAttr(progressSpan, "enrollment_count", progress.length);
    endSpan(progressSpan);
  } catch {
    // LMS not available — use stub data from request body
  }

  setAttr(dataSpan, "profile_from_lms", profileFromLms);
  setAttr(dataSpan, "catalog_from_lms", catalogFromLms);
  setAttr(dataSpan, "progress_from_lms", progressFromLms);
  setAttr(dataSpan, "catalogue_courses", catalogue.length);
  setAttr(dataSpan, "progress_entries", progress.length);
  setAttr(dataSpan, "has_profile", !!(profile && (profile.skills?.length || profile.goals)));
  endSpan(dataSpan);

  // ── Insufficient data check ──
  if (catalogue.length === 0) {
    return json({
      path: [],
      ai_status: "insufficient_data",
    }, 200);
  }

  const hasProfile = profile && (profile.skills?.length || profile.goals);
  if (!hasProfile || !profile) {
    return json({
      path: catalogue.slice(0, 5).map((c, i) => ({
        course_title: c.title,
        order: i + 1,
        why_this_fits: "Add skills and goals to get personalized recommendations.",
      })),
      ai_status: "insufficient_data",
    }, 200);
  }

  // TypeScript can't narrow `let` across try/catch — reassign to const
  const learnerProfile: LearnerProfile = profile;

  // ── Build prompt ──
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

    const gatewayResp = await env.AI_GATEWAY.fetch(
      new Request("https://ai-gateway/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          tier: "standard",
          org_id: body.org_id,
        }),
      })
    );

    setAttr(gatewayReqSpan, "status", gatewayResp.status);
    endSpan(gatewayReqSpan);

    if (!gatewayResp.ok) {
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

    const llm = await gatewayResp.json() as any;
    setAttr(pathSpan, "llm_model", llm.model_used || "unknown");
    setAttr(pathSpan, "llm_tokens", llm.tokens_used || 0);

    // Normalize: Workers AI sometimes returns response as already-parsed object
    const rawResponse: unknown = llm.response;
    setAttr(pathSpan, "response_type", typeof rawResponse);
    const responseText: string =
      typeof rawResponse === "string"
        ? rawResponse
        : JSON.stringify(rawResponse);

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
  // Extract JSON from response (LLM may wrap in markdown code blocks)
  const codeBlock = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlock ? codeBlock[1] : response.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) {
    setAttr(pathSpan, "parse_failed", "no_json");
    return fallbackPath(catalogue);
  }

  let courses: PathCourse[];
  try {
    const parsed = JSON.parse(jsonStr);
    // Accept both "courses" and "path" as the array key
    const rawList = parsed.courses || parsed.path || [];
    setAttr(pathSpan, "llm_returned_courses", rawList.length);
    courses = rawList.map((c: any, i: number) => ({
      course_title: c.course_title || c.title || "Unknown",
      order: c.order || i + 1,
      why_this_fits: c.why_this_fits || c.reason || c.explanation || "",
    }));
  } catch {
    setAttr(pathSpan, "parse_failed", "json_error");
    return fallbackPath(catalogue);
  }

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


