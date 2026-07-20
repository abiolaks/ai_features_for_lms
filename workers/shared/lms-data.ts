// ============================================================
// Shared LMS Data Fetchers
// ============================================================
// Each AI worker independently fetches learner profile, course
// catalogue, and progress from the LMS REST API. These shared
// functions encapsulate the fetch → parse → field-mapping →
// stub-fallback pattern, eliminating duplication across workers.
// ============================================================

import { fetchLms } from "./fetch-lms";

// ──── Types ────

export interface LearnerProfile {
  skills: string[];
  goals: string;
  experience_level: string;
  interests: string[];
  streak_days: number;
  points: number;
}

export interface CatalogueCourse {
  id?: string;
  title: string;
  difficulty: string;
  category: string;
  prerequisites: string[];
}

export interface ProgressEntry {
  title: string;
  status: "completed" | "in_progress";
  progress_pct: number;
}

// ──── Env (minimum bindings needed for LMS fetches) ────

export interface LmsEnv {
  LMS_GATEWAY_URL: string;
  LMS_INTERNAL_KEY: string;
}

// ════════════════════════════════════════════════════════
//  fetchProfile
// ════════════════════════════════════════════════════════

export async function fetchProfile(
  env: LmsEnv,
  stub?: Partial<LearnerProfile>,
): Promise<{ profile: LearnerProfile; fromLms: boolean }> {
  const defaultProfile: LearnerProfile = {
    skills: stub?.skills || [],
    goals: stub?.goals || "",
    experience_level: stub?.experience_level || "beginner",
    interests: stub?.interests || [],
    streak_days: stub?.streak_days || 0,
    points: stub?.points || 0,
  };

  try {
    const resp = await fetchLms(env, { path: `/api/v1/learner/profile` });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      const lmsProfile: LearnerProfile = {
        skills: data.skills || [],
        goals: data.goals || "",
        experience_level: data.experience_level || "beginner",
        interests: data.interests || [],
        streak_days: data.gamification?.login_streak || 0,
        points: data.gamification?.total_points || 0,
      };
      // Only use LMS profile if it has actual data
      if (lmsProfile.skills.length > 0 || lmsProfile.goals) {
        return { profile: lmsProfile, fromLms: true };
      }
    }
    return { profile: defaultProfile, fromLms: false };
  } catch {
    return { profile: defaultProfile, fromLms: false };
  }
}

// ════════════════════════════════════════════════════════
//  fetchCatalog
// ════════════════════════════════════════════════════════

export async function fetchCatalog(
  env: LmsEnv,
  orgId: string,
  stub?: CatalogueCourse[],
): Promise<{ catalogue: CatalogueCourse[]; fromLms: boolean }> {
  try {
    let resp = await fetchLms(env, { path: `/api/v1/catalog?organization_id=${orgId}` });

    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const items = raw.data || raw;
      // If authenticated catalog is empty, try public endpoint
      if (!items || items.length === 0) {
        resp = await fetchLms(env, { path: `/api/v1/public/courses` });
        if (resp.ok) {
          const publicRaw = (await resp.json()) as any;
          const publicItems = publicRaw.data || publicRaw;
          if (publicItems && publicItems.length > 0) {
            return {
              catalogue: publicItems.map(mapCatalogItem),
              fromLms: true,
            };
          }
        }
      } else {
        return {
          catalogue: items.map(mapCatalogItem),
          fromLms: true,
        };
      }
    }
    return { catalogue: stub || [], fromLms: false };
  } catch {
    return { catalogue: stub || [], fromLms: false };
  }
}

function mapCatalogItem(c: any): CatalogueCourse {
  return {
    id: c.id,
    title: c.title,
    difficulty: c.difficultyLevel || c.difficulty || "",
    category: c.category || "",
    prerequisites: c.prerequisites || [],
  };
}

// ════════════════════════════════════════════════════════
//  fetchProgress
// ════════════════════════════════════════════════════════

export async function fetchProgress(
  env: LmsEnv,
  learnerId: string,
  stub?: ProgressEntry[],
): Promise<{ progress: ProgressEntry[]; fromLms: boolean }> {
  try {
    const resp = await fetchLms(env, { path: `/api/v1/progress/user?userId=${learnerId}` });
    if (resp.ok) {
      const raw = (await resp.json()) as any;
      const data = raw.data || raw;
      const enrollments = data.enrollments || [];
      const lmsProgress = enrollments.map((e: any) => ({
        title: e.courseTitle || e.title || "",
        status: (e.status === "completed" ? "completed" : "in_progress") as "completed" | "in_progress",
        progress_pct: parseInt(e.progressPercent || e.progress_pct || "0") || 0,
      }));
      if (lmsProgress.length > 0) {
        return { progress: lmsProgress, fromLms: true };
      }
    }
    return { progress: stub || [], fromLms: false };
  } catch {
    return { progress: stub || [], fromLms: false };
  }
}
