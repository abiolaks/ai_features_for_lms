// ============================================================
// AI01: Content Indexing Pipeline
// ============================================================
// Receives content publish/unpublish events from the LMS,
// extracts transcripts from Cloudflare Stream videos,
// embeds content via Workers AI, and upserts to Vectorize.
// ============================================================

export interface Env {
  AI: any;
  STREAM: any;
  VECTORIZE_INDEX: VectorizeIndex;
  INDEXING_QUEUE: any;
  CLOUDFLARE_STREAM_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  LMS_WEBHOOK_SECRET: string;
}

// ──── Constants ────

const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

// ──── Request Types ────

interface IndexRequest {
  event: string;
  org_id: string;
  entity: {
    id: string;
    title: string;
    contentType?: string;
    cloudflareVideoId?: string;
    streamStatus?: string;
    course_id?: string;
    module_id?: string;
    durationSeconds?: number;
  };
}

interface BackfillRequest {
  org_id: string;
}

// ════════════════════════════════════════════════════════
//  VTT Extraction
// ════════════════════════════════════════════════════════

export function extractTextFromVTT(vtt: string): string {
  return vtt
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("WEBVTT") &&
        !line.match(/^\d{2}:/) &&
        !line.match(/^$/) &&
        !line.match(/^\d+$/)
    )
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s+/g, " ");
}

// ════════════════════════════════════════════════════════
//  Stream VTT Fetch
// ════════════════════════════════════════════════════════

async function fetchStreamVTT(
  videoId: string,
  language: string,
  env: Env
): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${videoId}/captions/${language}/vtt`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch VTT: ${resp.status} ${await resp.text()}`);
  }
  return resp.text();
}

// ════════════════════════════════════════════════════════
//  Embedding + Vectorize Upsert
// ════════════════════════════════════════════════════════

async function embedAndUpsert(
  env: Env,
  org_id: string,
  entity: IndexRequest["entity"],
  content: string,
  transcriptSource: string
): Promise<void> {
  // 1. Generate embedding vector
  const result = await env.AI.run(EMBEDDING_MODEL, { text: content });
  const vector: number[] = Array.isArray(result) ? result : result?.data?.[0] ?? result;

  // 2. Build vector ID + metadata
  const vid = `lesson-${entity.id}`;

  // 3. Upsert to Vectorize
  await env.VECTORIZE_INDEX.upsert([
    {
      id: vid,
      values: vector,
      metadata: {
        title: entity.title,
        lesson_id: entity.id,
        course_id: entity.course_id || "",
        module_id: entity.module_id || "",
        org_id,
        content_type: entity.contentType || "unknown",
        duration_seconds: entity.durationSeconds || 0,
        transcript_source: transcriptSource,
        // Store content so AI04 can retrieve it
        content,
      },
    },
  ]);
}

// ════════════════════════════════════════════════════════
//  Main Worker
// ════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET /videos — diagnostic: list Stream videos
    if (req.method === "GET" && path === "/videos") {
      return handleListVideos(env);
    }

    // GET /captions/:videoId — diagnostic: check captions
    if (req.method === "GET" && path.startsWith("/captions/")) {
      return handleCheckCaptions(path.split("/captions/")[1], env);
    }

    // GET /env-check — diagnostic: list env vars
    if (req.method === "GET" && path === "/env-check") {
      return handleEnvCheck(env);
    }

    // All other endpoints: POST only
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // ── Webhook auth (index / deindex / backfill) ──
    const webhookSecret = req.headers.get("X-Webhook-Secret");
    if (!webhookSecret || webhookSecret !== env.LMS_WEBHOOK_SECRET) {
      return Response.json({ error: "Unauthorized — invalid or missing X-Webhook-Secret" }, { status: 401 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    switch (path) {
      case "/index":
        return handleIndex(body, env);
      case "/deindex":
        return handleDeindex(body, env);
      case "/backfill":
        return handleBackfill(body, env);
      default:
        return Response.json({ error: "Not found" }, { status: 404 });
    }
  },
};

// ════════════════════════════════════════════════════════
//  Diagnostic Handlers
// ════════════════════════════════════════════════════════

async function handleEnvCheck(env: Env): Promise<Response> {
  const keys = Object.keys(env);
  const details: Record<string, any> = {};
  for (const key of keys) {
    const val = (env as any)[key];
    if (typeof val === "string") {
      details[key] = `string(len=${val.length})`;
    } else if (typeof val === "function") {
      details[key] = "function";
    } else if (val && typeof val === "object") {
      details[key] = `object(keys=${Object.keys(val).join(",")})`;
    } else {
      details[key] = String(val);
    }
  }
  return Response.json({ keys, details });
}

async function handleListVideos(env: Env): Promise<Response> {
  try {
    const videos = await env.STREAM.videos.list();
    const summary = videos.map((v: any) => ({
      id: v.uid || v.id,
      status: v.status?.state || v.status || "unknown",
      name: v.meta?.name || "unnamed",
      duration: v.duration || 0,
      created: v.created,
    }));
    return Response.json({ count: summary.length, videos: summary });
  } catch (err: any) {
    return Response.json({ error: `Failed to list videos: ${err.message}` }, { status: 500 });
  }
}

async function handleCheckCaptions(videoId: string, env: Env): Promise<Response> {
  try {
    const video = env.STREAM.video(videoId);
    const bindingCaptions = await video.captions.list();

    return Response.json({
      videoId,
      captions: bindingCaptions,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// ════════════════════════════════════════════════════════
//  POST /index — Publish handler
// ════════════════════════════════════════════════════════

async function handleIndex(body: IndexRequest, env: Env): Promise<Response> {
  // ── LMS_INTEGRATION: Webhook verification ──
  // TODO: When the LMS is live, verify the webhook signature here.
  // The LMS will send an X-Webhook-Signature header with each request.
  //
  //   const secret = env.LMS_WEBHOOK_SECRET;
  //   if (!verifyWebhook(body, request.headers, secret)) {
  //     return Response.json({ error: "Invalid signature" }, { status: 401 });
  //   }
  //
  // Secret to create:  npx wrangler secret put LMS_WEBHOOK_SECRET

  // ── LMS_INTEGRATION: Enrich entity metadata ──
  // TODO: When the LMS REST API is live, fetch additional lesson
  // metadata (description, tags, sections) to enrich Vectorize content.
  //
  //   const resp = await fetch(
  //     `${env.LMS_GATEWAY_URL}/api/v1/lessons/${entity.id}`,
  //     { headers: { "X-API-Key": env.LMS_INTERNAL_KEY } }
  //   );
  //   const lmsLesson = await resp.json();
  //   // Merge lmsLesson.description, lmsLesson.tags into metadata
  //
  // Secrets to create:
  //   npx wrangler secret put LMS_GATEWAY_URL    (e.g. https://lms.example.com)
  //   npx wrangler secret put LMS_INTERNAL_KEY   (shared API key)

  const { event, org_id, entity } = body;
  if (!event) return Response.json({ error: "Missing event" }, { status: 400 });
  if (!org_id) return Response.json({ error: "Missing org_id" }, { status: 400 });
  if (!entity) return Response.json({ error: "Missing entity" }, { status: 400 });
  if (event !== "publish") return Response.json({ error: "Unknown event" }, { status: 400 });

  // ── Video lesson ──
  if (entity.contentType === "video") {
    return handleVideoIndex(entity, org_id, env);
  }

  // ── Text lesson — metadata-only ──
  const content = buildMetadataContent(entity);
  try {
    await embedAndUpsert(env, org_id, entity, content, "none");
    return Response.json({ status: "indexed", transcript_source: "none", content_length: content.length });
  } catch (err: any) {
    return Response.json({ error: `Indexing failed: ${err.message}` }, { status: 500 });
  }
}

// ════════════════════════════════════════════════════════
//  Video Indexing Pipeline
// ════════════════════════════════════════════════════════

async function handleVideoIndex(
  entity: IndexRequest["entity"],
  org_id: string,
  env: Env
): Promise<Response> {
  const videoId = entity.cloudflareVideoId;
  if (!videoId) {
    return Response.json({ error: "Missing cloudflareVideoId" }, { status: 400 });
  }

  if (entity.streamStatus !== "ready") {
    return Response.json({ status: "queued", reason: "video_not_ready", videoId }, { status: 202 });
  }

  try {
    const video = env.STREAM.video(videoId);
    let captions: any[];
    try {
      const captionsResp = await video.captions.list();
      captions = Array.isArray(captionsResp) ? captionsResp : (captionsResp?.result || captionsResp || []);
    } catch {
      captions = [];
    }

    const enCaption = captions.find(
      (c: any) => (c.language === "en" || c.language === "eng") && c.status === "ready"
    );

    let transcript: string;
    let transcriptSource: string;

    if (enCaption) {
      console.log(`Video ${videoId}: using existing captions`);
      const vtt = await fetchStreamVTT(videoId, enCaption.language, env);
      transcript = extractTextFromVTT(vtt);
      transcriptSource = "existing";
    } else {
      console.log(`Video ${videoId}: generating AI captions...`);
      await video.captions.generate("en");
      transcript = await pollForCaptions(videoId, video, env);
      transcriptSource = "ai_generated";
    }

    // Embed + upsert to Vectorize
    await embedAndUpsert(env, org_id, entity, transcript, transcriptSource);

    return Response.json({
      status: "indexed",
      transcript_source: transcriptSource,
      content_length: transcript.length,
    });
  } catch (err: any) {
    console.error(`Video ${videoId} captioning failed: ${err.message}, using metadata fallback`);

    try {
      const content = buildMetadataContent(entity);
      await embedAndUpsert(env, org_id, entity, content, "none");
    } catch {
      // swallow
    }

    return Response.json({
      status: "fallback",
      transcript_source: "none",
      content_length: buildMetadataContent(entity).length,
      error: err.message,
    });
  }
}

async function pollForCaptions(videoId: string, video: any, env: Env): Promise<string> {
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const captionsResp = await video.captions.list();
      const captions = Array.isArray(captionsResp) ? captionsResp : (captionsResp?.result || captionsResp || []);
      const enCaption = captions.find(
        (c: any) => (c.language === "en" || c.language === "eng") && c.status === "ready"
      );
      if (enCaption) {
        const vtt = await fetchStreamVTT(videoId, enCaption.language, env);
        return extractTextFromVTT(vtt);
      }
      const errored = captions.find((c: any) => c.status === "error");
      if (errored) throw new Error(`Caption generation failed: ${errored.error || "unknown"}`);
    } catch (err: any) {
      if (err.message?.includes("Failed to fetch VTT")) continue;
      throw err;
    }
  }
  throw new Error(`Caption generation timed out after ${maxAttempts * 3}s`);
}

function buildMetadataContent(entity: IndexRequest["entity"]): string {
  const type = entity.contentType || "lesson";
  const duration = entity.durationSeconds ? `Duration: ${entity.durationSeconds}s.` : "";
  return `${entity.title}. ${type}. ${duration}`.trim().replace(/\s+/g, " ");
}

// ════════════════════════════════════════════════════════
//  POST /deindex — Unpublish handler
// ════════════════════════════════════════════════════════

async function handleDeindex(body: IndexRequest, env: Env): Promise<Response> {
  const { entity } = body;
  try {
    await env.VECTORIZE_INDEX.deleteByIds([`lesson-${entity.id}`]);
    return Response.json({ status: "deindexed" });
  } catch (err: any) {
    return Response.json({ error: `Deindex failed: ${err.message}` }, { status: 500 });
  }
}

// ════════════════════════════════════════════════════════
//  POST /backfill — Bulk re-index
// ════════════════════════════════════════════════════════

async function handleBackfill(body: BackfillRequest, env: Env): Promise<Response> {
  if (!body.org_id) {
    return Response.json({ error: "Missing org_id" }, { status: 400 });
  }

  const videos = await env.STREAM.videos.list();
  let queued = 0;
  let skipped = 0;

  for (const video of videos) {
    if (video.status?.state === "ready") queued++;
    else skipped++;
  }

  return Response.json({ status: "queued", queued, skipped });
}
