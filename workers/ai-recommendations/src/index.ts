// ============================================================
// AI07 + AI07b (slim): Enhanced Course Recommendations
// ============================================================
// Front door (AI07): fetch LMS baseline recommendations and
// enhance each with an AI-generated "why this fits you".
//
// Fallback engine (AI07b, slimmed): staging LMS currently
// returns `recommendations: []`, so when LMS recs are empty
// this worker generates recommendations from the catalogue
// using two signals:
//   1. Content similarity — Vectorize (lms-lessons index)
//   2. AI scoring        — AI03 Gateway (curriculum advisor)
// Collaborative (D1) signal deferred — no enrollment history yet.
//
// Results cached in KV (LMS_CACHE) for 24h. Degraded responses
// are never cached so recovery is instant.
// ============================================================

import { fetchLms } from "../../shared/fetch-lms";
import { json, handleCors } from "../../shared/cors";
import { startSpan, setAttr, endSpan } from "../../shared/observability";
import { fetchProfile, fetchCatalog, fetchProgress, type LearnerProfile as LmsLearnerProfile, type CatalogueCourse as LmsCatalogueCourse, type ProgressEntry as LmsProgressEntry } from "../../shared/lms-data";
import { callGateway } from "../../shared/gateway";

export interface Env {
  AI_GATEWAY: Fetcher;
  LMS_CACHE: KVNamespace;
  AI?: any; // Workers AI (embeddings) — optional, mocked in tests
  VECTORIZE_INDEX?: VectorizeIndex; // lms-lessons — optional
  LMS_GATEWAY_URL: string;
  LMS_INTERNAL_KEY: string;
  REC_WEIGHT_CONTENT?: string; // default 0.35
  REC_WEIGHT_AI?: string; // default 0.65
}

const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";
const CACHE_TTL_SECONDS = 86400; // 24h
const MAX_RECS = 5;
const MAX_CANDIDATES = 12;
const PREREQ_BOOST = 15;

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
  id?: string;
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

interface LmsRec {
  course_id?: string;
  course_title: string;
  lms_reason: string;
}

interface Recommendation {
  course_title: string;
  lms_reason: string;
  ai_why_this_fits: string;
  score?: number;
  fit_level?: "strong" | "moderate" | "weak";
  signals?: { content_similarity: number; ai_score: number };
}

interface RecRequest {
  learner_id: string;
  org_id: string;
  course_id?: string;
  refresh?: boolean;
  // ── Stub mode: provide data directly when LMS is unavailable ──
  profile?: LearnerProfile;
  catalogue?: CatalogueCourse[];
  progress?: ProgressEntry[];
  lms_recommendations?: LmsRec[];
}

type AiStatus = "enhanced" | "generated" | "degraded" | "unavailable";

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const preflight = handleCors(req);
    if (preflight) return preflight;

    const url = new URL(req.url);
    const origin = req.headers.get("Origin");

    if (url.pathname !== "/recommendations/dashboard" && url.pathname !== "/recommendations/next") {
      return json({ error: "Not found" }, 404, origin);
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    // GET → query params; POST → body (may carry stub data)
    let body: RecRequest;
    if (req.method === "GET") {
      body = {
        learner_id: url.searchParams.get("learner_id") || "",
        org_id: url.searchParams.get("org_id") || "",
        course_id: url.searchParams.get("course_id") || undefined,
        refresh: url.searchParams.get("refresh") === "true",
      };
    } else {
      try {
        body = (await req.json()) as RecRequest;
      } catch {
        return json({ error: "Invalid JSON" }, 400, origin);
      }
    }

    if (!body.learner_id) return json({ error: "missing_field: learner_id" }, 400, origin);
    if (!body.org_id) return json({ error: "missing_field: org_id" }, 400, origin);

    if (url.pathname === "/recommendations/next") {
      if (!body.course_id) return json({ error: "missing_field: course_id" }, 400, origin);
      return handleNext(body, env, origin);
    }
    return handleDashboard(body, env, origin);
  },
};

// ════════════════════════════════════════════════════════
//  KV Cache
// ════════════════════════════════════════════════════════

async function cacheLookup(env: Env, key: string, refresh: boolean): Promise<Response | null> {
  const span = startSpan("cache.lookup");
  setAttr(span, "cache.key", key);
  if (refresh) {
    setAttr(span, "cache.hit", false);
    setAttr(span, "cache.bypassed", true);
    endSpan(span);
    return null;
  }
  try {
    const cached = await env.LMS_CACHE.get(key);
    setAttr(span, "cache.hit", !!cached);
    endSpan(span);
    if (cached) {
      const parsed = JSON.parse(cached);
      return json({ ...parsed, source: "cache" }, 200);
    }
  } catch {
    setAttr(span, "cache.hit", false);
    setAttr(span, "cache.error", true);
    endSpan(span);
  }
  return null;
}

async function cacheStore(env: Env, key: string, payload: unknown): Promise<void> {
  const span = startSpan("cache.write");
  setAttr(span, "cache.key", key);
  try {
    await env.LMS_CACHE.put(key, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
    setAttr(span, "ok", true);
  } catch {
    setAttr(span, "ok", false);
  }
  endSpan(span);
}

// ════════════════════════════════════════════════════════
//  LMS Data Gathering (live → stub fallback)
// ════════════════════════════════════════════════════════

interface GatheredData {
  lmsRecs: LmsRec[];
  profile: LearnerProfile;
  catalogue: CatalogueCourse[];
  progress: ProgressEntry[];
}

async function gatherData(body: RecRequest, env: Env, fetchRecs: boolean): Promise<GatheredData> {
  const dataSpan = startSpan("data.fetch");
  setAttr(dataSpan, "learner_id", body.learner_id);
  setAttr(dataSpan, "org_id", body.org_id);

  // ── LMS baseline recommendations (unique to ai-recommendations) ──
  let lmsRecs: LmsRec[] = body.lms_recommendations || [];
  let recsFromLms = false;
  if (fetchRecs) {
    try {
      const span = startSpan("lms.fetch");
      setAttr(span, "endpoint", "recommendations");
      const resp = await fetchLms(env, { path: `/api/v1/courses/recommendations` });
      setAttr(span, "status", resp.status);
      if (resp.ok) {
        const raw = (await resp.json()) as any;
        const items = raw.data?.recommendations || [];
        const mapped = items
          .map((r: any) => ({
            course_id: r.course_id || r.courseId || r.id,
            course_title: r.course_title || r.courseTitle || r.title || "",
            lms_reason: r.reason || r.lms_reason || "",
          }))
          .filter((r: LmsRec) => r.course_title);
        if (mapped.length > 0) lmsRecs = mapped;
        recsFromLms = true;
      }
      setAttr(span, "rec_count", lmsRecs.length);
      endSpan(span);
    } catch {
      // stub fallback
    }
  }

  // ── Learner profile (shared) ──
  const profSpan = startSpan("lms.fetch");
  setAttr(profSpan, "endpoint", "profile");
  const { profile: sharedProfile, fromLms: profileFromLms } = await fetchProfile(env, body.profile as any);
  setAttr(profSpan, "status", profileFromLms ? 200 : "stub");
  endSpan(profSpan);
  const profile: LearnerProfile = { ...sharedProfile };

  // ── Catalogue (shared) ──
  const catSpan = startSpan("lms.fetch");
  setAttr(catSpan, "endpoint", "catalog");
  const { catalogue: sharedCat, fromLms: catalogFromLms } = await fetchCatalog(env, body.org_id, body.catalogue as any);
  setAttr(catSpan, "status", catalogFromLms ? 200 : "stub");
  setAttr(catSpan, "course_count", sharedCat.length);
  endSpan(catSpan);
  const catalogue: CatalogueCourse[] = sharedCat;

  // ── Progress (shared) ──
  const progSpan = startSpan("lms.fetch");
  setAttr(progSpan, "endpoint", "progress");
  const { progress: sharedProg, fromLms: progressFromLms } = await fetchProgress(env, body.learner_id, body.progress as any);
  setAttr(progSpan, "status", progressFromLms ? 200 : "stub");
  endSpan(progSpan);
  const progress: ProgressEntry[] = sharedProg;

  setAttr(dataSpan, "recs_from_lms", recsFromLms);
  setAttr(dataSpan, "profile_from_lms", profileFromLms);
  setAttr(dataSpan, "catalog_from_lms", catalogFromLms);
  setAttr(dataSpan, "progress_from_lms", progressFromLms);
  setAttr(dataSpan, "lms_rec_count", lmsRecs.length);
  setAttr(dataSpan, "catalogue_courses", catalogue.length);
  endSpan(dataSpan);

  return { lmsRecs, profile, catalogue, progress };
}

// ════════════════════════════════════════════════════════
//  GET|POST /recommendations/dashboard
// ════════════════════════════════════════════════════════

async function handleDashboard(body: RecRequest, env: Env, origin?: string | null): Promise<Response> {
  const cacheKey = `recs:${body.org_id}:${body.learner_id}`;
  const cached = await cacheLookup(env, cacheKey, !!body.refresh);
  if (cached) return cached;

  const topSpan = startSpan("recs.generate");
  setAttr(topSpan, "endpoint", "dashboard");
  setAttr(topSpan, "learner_id", body.learner_id);

  const { lmsRecs, profile, catalogue, progress } = await gatherData(body, env, true);

  if (lmsRecs.length === 0 && catalogue.length === 0) {
    setAttr(topSpan, "tier", "unavailable");
    setAttr(topSpan, "ai_status", "unavailable");
    endSpan(topSpan);
    return json({ recommendations: [], ai_status: "unavailable" as AiStatus, generated_at: new Date().toISOString() }, 200, origin);
  }

  let recommendations: Recommendation[];
  let aiStatus: AiStatus;

  if (lmsRecs.length > 0) {
    // ── AI07: enhance LMS recs with "why this fits" ──
    setAttr(topSpan, "tier", "enhance");
    const result = await enhanceLmsRecs(lmsRecs.slice(0, MAX_RECS), profile, progress, body.org_id, env);
    recommendations = result.recs;
    aiStatus = result.aiStatus;
  } else {
    // ── AI07b (slim): generate from catalogue via signals ──
    setAttr(topSpan, "tier", "engine");
    const result = await runEngine(profile, catalogue, progress, body.org_id, env, null);
    recommendations = result.recs;
    aiStatus = result.aiStatus;
  }

  setAttr(topSpan, "ai_status", aiStatus);
  setAttr(topSpan, "rec_count", recommendations.length);
  endSpan(topSpan);

  const payload = { recommendations, ai_status: aiStatus, generated_at: new Date().toISOString() };
  if (aiStatus !== "degraded") await cacheStore(env, cacheKey, payload);
  return json({ ...payload, source: "fresh" }, 200, origin);
}

// ════════════════════════════════════════════════════════
//  GET|POST /recommendations/next
// ════════════════════════════════════════════════════════

async function handleNext(body: RecRequest, env: Env, origin?: string | null): Promise<Response> {
  const cacheKey = `recs:next:${body.org_id}:${body.learner_id}:${body.course_id}`;
  const cached = await cacheLookup(env, cacheKey, !!body.refresh);
  if (cached) return cached;

  const topSpan = startSpan("recs.generate");
  setAttr(topSpan, "endpoint", "next");
  setAttr(topSpan, "course_id", body.course_id);

  const { profile, catalogue, progress } = await gatherData(body, env, false);

  if (catalogue.length === 0) {
    setAttr(topSpan, "tier", "unavailable");
    setAttr(topSpan, "ai_status", "unavailable");
    endSpan(topSpan);
    return json({ next_courses: [], ai_status: "unavailable" as AiStatus, generated_at: new Date().toISOString() }, 200, origin);
  }

  const current =
    catalogue.find((c) => c.id === body.course_id || c.title === body.course_id) || null;
  setAttr(topSpan, "tier", "engine");
  setAttr(topSpan, "current_course_found", !!current);

  const result = await runEngine(profile, catalogue, progress, body.org_id, env, current);

  setAttr(topSpan, "ai_status", result.aiStatus);
  setAttr(topSpan, "rec_count", result.recs.length);
  endSpan(topSpan);

  const payload = {
    next_courses: result.recs.slice(0, 3).map((r) => ({
      course_title: r.course_title,
      why_this_fits: r.ai_why_this_fits,
      score: r.score,
      fit_level: r.fit_level,
    })),
    ai_status: result.aiStatus,
    generated_at: new Date().toISOString(),
  };
  if (result.aiStatus !== "degraded") await cacheStore(env, cacheKey, payload);
  return json({ ...payload, source: "fresh" }, 200, origin);
}

// ════════════════════════════════════════════════════════
//  AI07 Enhance Path — LMS recommends WHAT, AI explains WHY
// ════════════════════════════════════════════════════════

async function enhanceLmsRecs(
  lmsRecs: LmsRec[],
  profile: LearnerProfile,
  progress: ProgressEntry[],
  orgId: string,
  env: Env
): Promise<{ recs: Recommendation[]; aiStatus: AiStatus }> {
  const prompt = [
    `You write one-sentence personalized course recommendations for a learning platform.`,
    ``,
    `Learner profile:`,
    `- Skills: ${(profile.skills || []).join(", ") || "unknown"}`,
    `- Goals: ${profile.goals || "unknown"}`,
    `- Completed courses: ${progress.filter((p) => p.status === "completed").map((p) => p.title).join(", ") || "none"}`,
    `- In progress: ${progress.filter((p) => p.status === "in_progress").map((p) => p.title).join(", ") || "none"}`,
    ``,
    `Recommended courses:`,
    JSON.stringify(lmsRecs.map((r) => ({ course_title: r.course_title })), null, 2),
    ``,
    `For EACH course, write ONE sentence explaining why it fits this specific learner.`,
    `Reference their skills, goals, or progress. Be specific, not generic.`,
    `Return ONLY a JSON array: [{"course_title": "...", "why_this_fits": "..."}]`,
  ].join("\n");

  const text = await callGatewayWithSpan(env, prompt, orgId);
  if (!text) {
    // AI03 down → return LMS recs without explanations
    return {
      recs: lmsRecs.map((r) => ({ course_title: r.course_title, lms_reason: r.lms_reason, ai_why_this_fits: "" })),
      aiStatus: "degraded",
    };
  }

  const parsed = parseJsonArray(text);
  const byTitle = new Map<string, string>();
  for (const item of parsed || []) {
    if (item?.course_title && item?.why_this_fits) {
      byTitle.set(String(item.course_title).toLowerCase(), String(item.why_this_fits));
    }
  }

  const recs = lmsRecs.map((r) => ({
    course_title: r.course_title,
    lms_reason: r.lms_reason,
    ai_why_this_fits: byTitle.get(r.course_title.toLowerCase()) || "",
  }));
  const enhancedCount = recs.filter((r) => r.ai_why_this_fits).length;
  return { recs, aiStatus: enhancedCount > 0 ? "enhanced" : "degraded" };
}

// ════════════════════════════════════════════════════════
//  AI07b Slim Engine — content similarity + AI scoring
// ════════════════════════════════════════════════════════

async function runEngine(
  profile: LearnerProfile,
  catalogue: CatalogueCourse[],
  progress: ProgressEntry[],
  orgId: string,
  env: Env,
  nextAfter: CatalogueCourse | null
): Promise<{ recs: Recommendation[]; aiStatus: AiStatus }> {
  const enrolledTitles = new Set(progress.map((p) => p.title.toLowerCase()));
  if (nextAfter) enrolledTitles.add(nextAfter.title.toLowerCase());
  const candidates = catalogue
    .filter((c) => !enrolledTitles.has(c.title.toLowerCase()))
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) return { recs: [], aiStatus: "unavailable" };

  // ── Signal 1: content similarity (Vectorize) ──
  const queryText = nextAfter
    ? nextAfter.title
    : progress.filter((p) => p.status === "completed").map((p) => p.title).join(". ") ||
      (profile.interests || []).join(", ");
  const contentScores = await contentSignal(env, queryText, orgId);

  // ── Signal 2: AI scoring (AI03 Gateway) ──
  const aiScores = await aiScoringSignal(env, profile, candidates, progress, orgId, nextAfter);

  const wContent = parseFloat(env.REC_WEIGHT_CONTENT || "0.35");
  const wAi = parseFloat(env.REC_WEIGHT_AI || "0.65");
  const aiAvailable = aiScores !== null;

  const blendSpan = startSpan("score.blend");
  setAttr(blendSpan, "candidates", candidates.length);
  setAttr(blendSpan, "content_matches", contentScores.size);
  setAttr(blendSpan, "ai_available", aiAvailable);
  if (!aiAvailable) setAttr(blendSpan, "missing_signals", ["ai_score", "collaborative", "skill_gap"]);

  const recs: Recommendation[] = candidates.map((c) => {
    const content01 = (c.id && contentScores.get(c.id)) || 0;
    const ai = aiScores?.get(c.title.toLowerCase());
    const aiScore = ai?.score ?? 0;
    // Weight redistribution when AI is down: content-only ranking
    let score = aiAvailable
      ? Math.round(content01 * 100 * wContent + aiScore * wAi)
      : Math.round(content01 * 100);
    // Progression boost: candidate lists the completed course as a prerequisite
    if (nextAfter && (c.prerequisites || []).some((p) => p.toLowerCase() === nextAfter.title.toLowerCase())) {
      score += PREREQ_BOOST;
    }
    return {
      course_title: c.title,
      lms_reason: "",
      ai_why_this_fits: ai?.reason || "",
      score,
      fit_level: score > 80 ? ("strong" as const) : score >= 50 ? ("moderate" as const) : ("weak" as const),
      signals: { content_similarity: Math.round(content01 * 100) / 100, ai_score: aiScore },
    };
  });

  recs.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = recs.slice(0, MAX_RECS);
  setAttr(blendSpan, "top_score", top[0]?.score || 0);
  endSpan(blendSpan);

  return { recs: top, aiStatus: aiAvailable ? "generated" : "degraded" };
}

// ── Signal 1: Vectorize content similarity → Map<course_id, best score> ──

async function contentSignal(env: Env, queryText: string, orgId: string): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!env.AI || !env.VECTORIZE_INDEX || !queryText) return scores;
  const span = startSpan("signal.content");
  try {
    const embedding = await env.AI.run(EMBEDDING_MODEL, { text: queryText });
    const vector: number[] = embedding.data?.[0] ?? embedding;
    const results = await env.VECTORIZE_INDEX.query(vector, { topK: 20, returnMetadata: true });
    for (const m of (results.matches || []) as any[]) {
      const meta = m.metadata || {};
      if (meta.org_id && orgId && meta.org_id !== orgId) continue; // org isolation
      const courseId = meta.course_id;
      if (!courseId) continue;
      const prev = scores.get(courseId) || 0;
      if (m.score > prev) scores.set(courseId, m.score);
    }
    setAttr(span, "matched_courses", scores.size);
    setAttr(span, "ok", true);
  } catch (err: any) {
    setAttr(span, "ok", false);
    setAttr(span, "error", err.message);
  }
  endSpan(span);
  return scores;
}

// ── Signal 2: AI scoring → Map<title, {score, reason, fit_level}> | null ──

async function aiScoringSignal(
  env: Env,
  profile: LearnerProfile,
  candidates: CatalogueCourse[],
  progress: ProgressEntry[],
  orgId: string,
  nextAfter: CatalogueCourse | null
): Promise<Map<string, { score: number; reason: string }> | null> {
  const span = startSpan("signal.ai_scoring");
  setAttr(span, "candidates", candidates.length);

  const header = nextAfter
    ? `You are recommending the NEXT course for a learner who just completed "${nextAfter.title}" (${nextAfter.difficulty || "unknown difficulty"}). Consider prerequisites, skill progression, and the learner's goals. Prefer courses one difficulty step harder.`
    : `You are a curriculum advisor for a learning platform. Rank candidate courses by how well they fit this specific learner. Be honest — if a course is clearly too advanced or too basic, score it low.`;

  const prompt = [
    header,
    ``,
    `Learner profile:`,
    `- Skills: ${(profile.skills || []).join(", ") || "unknown"}`,
    `- Goals: ${profile.goals || "unknown"}`,
    `- Level: ${profile.experience_level || "beginner"}`,
    `- Completed: ${progress.filter((p) => p.status === "completed").map((p) => p.title).join(", ") || "none"}`,
    `- In progress: ${progress.filter((p) => p.status === "in_progress").map((p) => p.title).join(", ") || "none"}`,
    ``,
    `Candidate courses:`,
    JSON.stringify(candidates.map((c) => ({ title: c.title, difficulty: c.difficulty, category: c.category })), null, 2),
    ``,
    `For each course provide: score (0-100, fit for THIS learner) and reason (one specific sentence).`,
    `Return ONLY a JSON array: [{"course_title": "...", "score": 85, "reason": "..."}]`,
  ].join("\n");

  const text = await callGatewayWithSpan(env, prompt, orgId);
  if (!text) {
    setAttr(span, "ok", false);
    endSpan(span);
    return null;
  }

  const parsed = parseJsonArray(text);
  if (!parsed) {
    setAttr(span, "ok", false);
    setAttr(span, "parse_error", true);
    endSpan(span);
    return null;
  }

  const scores = new Map<string, { score: number; reason: string }>();
  for (const item of parsed) {
    const title = item?.course_title || item?.title;
    if (!title) continue;
    scores.set(String(title).toLowerCase(), {
      score: Math.max(0, Math.min(100, Number(item.score) || 0)),
      reason: String(item.reason || ""),
    });
  }
  setAttr(span, "ok", true);
  setAttr(span, "scored", scores.size);
  endSpan(span);
  return scores.size > 0 ? scores : null;
}

// ════════════════════════════════════════════════════════
//  AI03 Gateway call (wraps shared adapter with span tracking)
// ════════════════════════════════════════════════════════

async function callGatewayWithSpan(env: Env, prompt: string, orgId: string): Promise<string | null> {
  const span = startSpan("ai_gateway.generate");
  setAttr(span, "tier", "standard");
  const result = await callGateway(env.AI_GATEWAY, prompt, orgId);
  setAttr(span, "status", result ? 200 : 502);
  if (result) {
    setAttr(span, "llm_model", result.model);
    setAttr(span, "llm_tokens", result.tokens);
  }
  endSpan(span);
  return result?.text ?? null;
}

function parseJsonArray(text: string): any[] | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
