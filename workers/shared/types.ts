// ============================================================
// Shared TypeScript Types — all AI Workers use these
// ============================================================

// ──── AI03 Gateway ────
export interface GenerateRequest {
  messages: { role: string; content: string }[];
  tier: 'standard' | 'quality';
  org_id: string;
}

export interface GenerateResponse {
  response: string;
  model_used: string;
  provider: 'cloudflare';
  tokens_used: number;
  throttle_warning: boolean;
}

// ──── LMS API ────
export interface LmsCourse {
  id: string;
  title: string;
  description: string;
  contentType: 'video' | 'text' | 'quiz';
  cloudflareVideoId?: string;
  streamStatus?: 'pending' | 'processing' | 'ready' | 'error';
  metadata: Record<string, unknown>[];
}

export interface LmsLesson {
  id: string;
  title: string;
  content?: string;
  contentType: 'video' | 'text';
  cloudflareVideoId?: string;
  streamStatus?: string;
  courseId: string;
  order: number;
  duration?: number;
}

export interface LmsLearnerProfile {
  id: string;
  org_id: string;
  skill_levels: Record<string, number>;
  completed_courses: string[];
  interests: string[];
}

export interface LmsQuizResult {
  id: string;
  quiz_id: string;
  learner_id: string;
  score: number;
  max_score: number;
  answers: { question_id: string; selected: string; correct: boolean }[];
  completed_at: string;
}

// ──── Budget (D1) ────
export interface OrgBudget {
  org_id: string;
  monthly_token_cap: number;
  tokens_used_this_period: number;
  billing_period_start: number;
}

// ──── Indexing Queue ────
export interface IndexingJob {
  type: 'lesson' | 'course' | 'assessment';
  id: string;
  org_id: string;
  cloudflareVideoId?: string;
  action: 'index' | 'reindex' | 'delete';
}

// ──── AI Search ────
export interface AiSearchDocument {
  id: string;
  org_id: string;
  content: string;
  metadata: {
    title: string;
    course_id?: string;
    contentType: string;
    source: string;
  };
}
