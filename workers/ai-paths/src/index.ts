// ============================================================
// AI06: Personalized Learning Paths
// ============================================================
// Generates an AI-personalized, ordered learning path based on
// learner profile, progress, and available course catalogue.
// Calls AI03 Gateway (service binding) with a curriculum
// design prompt.
// ============================================================

export interface Env {
  AI_GATEWAY: Fetcher;
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
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const url = new URL(req.url);
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
  // When LMS is live, uncomment and wrap in lms-fetch span:
  //
  //   const profileSpan = startSpan("lms.fetch");
  //   setAttr(profileSpan, "method", "GET");
  //   setAttr(profileSpan, "path", "/api/v1/learner/profile");
  //   setAttr(profileSpan, "learner_id", body.learner_id);
  //   const resp = await fetch(
  //     `${env.LMS_GATEWAY_URL}/api/v1/learner/profile?learner_id=${body.learner_id}`,
  //     { headers: { "X-API-Key": env.LMS_INTERNAL_KEY } }
  //   );
  //   setAttr(profileSpan, "status", resp.status);
  //   const profile = resp.ok ? await resp.json() : undefined;
  //   endSpan(profileSpan);
  //
  // Secrets needed: LMS_GATEWAY_URL, LMS_INTERNAL_KEY
  const profile = body.profile;

  // ── LMS: Fetch course catalogue ──
  // When LMS is live, uncomment and wrap in lms-fetch span:
  //
  //   const catalogSpan = startSpan("lms.fetch");
  //   setAttr(catalogSpan, "method", "GET");
  //   setAttr(catalogSpan, "path", "/api/v1/catalog");
  //   setAttr(catalogSpan, "org_id", body.org_id);
  //   const resp = await fetch(
  //     `${env.LMS_GATEWAY_URL}/api/v1/catalog?org_id=${body.org_id}`,
  //     { headers: { "X-API-Key": env.LMS_INTERNAL_KEY } }
  //   );
  //   setAttr(catalogSpan, "status", resp.status);
  //   const catalogue = resp.ok ? await resp.json() : [];
  //   setAttr(catalogSpan, "course_count", catalogue.length);
  //   endSpan(catalogSpan);
  const catalogue = body.catalogue || [];
  setAttr(dataSpan, "catalogue_stub", true);

  // ── LMS: Fetch learner progress ──
  // When LMS is live, uncomment and wrap in lms-fetch span:
  //
  //   const progressSpan = startSpan("lms.fetch");
  //   setAttr(progressSpan, "method", "GET");
  //   setAttr(progressSpan, "path", "/api/v1/progress/user");
  //   setAttr(progressSpan, "learner_id", body.learner_id);
  //   const resp = await fetch(
  //     `${env.LMS_GATEWAY_URL}/api/v1/progress/user?learner_id=${body.learner_id}`,
  //     { headers: { "X-API-Key": env.LMS_INTERNAL_KEY } }
  //   );
  //   setAttr(progressSpan, "status", resp.status);
  //   const progress = resp.ok ? await resp.json() : [];
  //   setAttr(progressSpan, "enrollment_count", progress.length);
  //   endSpan(progressSpan);
  const progress = body.progress || [];
  setAttr(dataSpan, "progress_stub", true);

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
  const prompt = buildPrompt(profile, catalogue, progress);

  // ═══════════════════════════════════════════════════════
  //  SPAN: path.generate — LLM call + validation
  // ═══════════════════════════════════════════════════════
  const pathSpan = startSpan("path.generate");
  setAttr(pathSpan, "org_id", body.org_id);
  setAttr(pathSpan, "catalogue_courses_considered", catalogue.length);
  setAttr(pathSpan, "completed_courses", progress.filter((p) => p.status === "completed").length);
  setAttr(pathSpan, "has_profile_goals", !!profile.goals);
  setAttr(pathSpan, "has_profile_skills", !!(profile.skills && profile.skills.length > 0));

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
        path: catalogue.slice(0, 5).map((c, i) => ({
          course_title: c.title,
          order: i + 1,
          why_this_fits: "",
        })),
        ai_status: "degraded",
      }, 200);
    }

    const llm = await gatewayResp.json() as any;
    setAttr(pathSpan, "llm_model", llm.model_used || "unknown");
    setAttr(pathSpan, "llm_tokens", llm.tokens_used || 0);

    const path = parsePath(llm.response, catalogue, progress, pathSpan);
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
      path: catalogue.slice(0, 5).map((c, i) => ({
        course_title: c.title,
        order: i + 1,
        why_this_fits: "",
      })),
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

function fallbackPath(catalogue: CatalogueCourse[]): PathCourse[] {
  return catalogue.slice(0, 5).map((c, i) => ({
    course_title: c.title,
    order: i + 1,
    why_this_fits: "",
  }));
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
