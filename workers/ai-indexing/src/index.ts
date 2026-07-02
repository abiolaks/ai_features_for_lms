// ============================================================
// AI01: Content Indexing Pipeline
// ============================================================
// Receives content publish/unpublish events from the LMS,
// extracts transcripts from Cloudflare Stream videos,
// and uploads to AI Search for automatic chunking/embedding.
// ============================================================

export interface Env {
  STREAM: any;
  AI_SEARCH: any;
  INDEXING_QUEUE: any;
  CLOUDFLARE_STREAM_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

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

/**
 * Extract clean text from a WebVTT caption file.
 * Skips WEBVTT header, timestamps, blank lines, and cue numbers.
 * Normalizes whitespace.
 */
export function extractTextFromVTT(vtt: string): string {
  return vtt
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("WEBVTT") &&
        !line.match(/^\d{2}:/) && // skip timestamps (00:00:00.000 --> 00:00:05.240)
        !line.match(/^$/) && // skip blank lines
        !line.match(/^\d+$/) // skip cue numbers
    )
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s+/g, " "); // normalize whitespace
}

// ════════════════════════════════════════════════════════
//  Stream VTT Fetch (REST API — edge-only, tested via integration)
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

    // GET /captions/:videoId — diagnostic: check captions status
    if (req.method === "GET" && path.startsWith("/captions/")) {
      const videoId = path.split("/captions/")[1];
      return handleCheckCaptions(videoId, env);
    }

    // GET /env-check — diagnostic: list available env vars (no values)
    if (req.method === "GET" && path === "/env-check") {
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

    // All other endpoints: POST only
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Parse JSON
    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Route
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
//  GET /captions/:videoId — Diagnostic: check caption status
// ════════════════════════════════════════════════════════

async function handleCheckCaptions(videoId: string, env: Env): Promise<Response> {
  try {
    const video = env.STREAM.video(videoId);

    // Get video details for customer code
    let details: any = null;
    try {
      details = await video.details();
    } catch (e: any) {
      details = { error: e.message };
    }

    // Try captions via binding
    let bindingCaptions: any = null;
    let bindingError: string | null = null;
    try {
      bindingCaptions = await video.captions.list();
    } catch (e: any) {
      bindingError = e.message;
    }

    // Extract customer code from preview URL
    let customerCode: string | null = null;
    let token: string | null = null;
    let signedVttUrl: string | null = null;
    let publicVttUrl: string | null = null;

    if (details?.preview) {
      const match = details.preview.match(/customer-([^.]+)\.cloudflarestream\.com/);
      if (match) {
        customerCode = match[1];
        publicVttUrl = `https://customer-${customerCode}.cloudflarestream.com/${videoId}/captions/en/vtt`;

        // Generate signed token for accessing protected content
        try {
          token = await video.generateToken();
          signedVttUrl = `https://customer-${customerCode}.cloudflarestream.com/${token}/captions/en/vtt`;
        } catch (e: any) {
          token = `error: ${e.message}`;
        }
      }
    }

    // Try public VTT URL
    let vttPreview: string | null = null;
    let vttError: string | null = null;
    if (publicVttUrl) {
      try {
        const resp = await fetch(publicVttUrl);
        const text = await resp.text();
        if (resp.ok && text.startsWith("WEBVTT")) {
          vttPreview = text.substring(0, 500);
        } else {
          vttError = `HTTP ${resp.status}: ${text.substring(0, 200)}`;
        }
      } catch (e: any) {
        vttError = e.message;
      }
    }

    // Try signed VTT URL
    let signedVttPreview: string | null = null;
    let signedVttError: string | null = null;
    if (signedVttUrl) {
      try {
        const resp = await fetch(signedVttUrl);
        const text = await resp.text();
        if (resp.ok && text.startsWith("WEBVTT")) {
          signedVttPreview = text.substring(0, 500);
        } else {
          signedVttError = `HTTP ${resp.status}: ${text.substring(0, 200)}`;
        }
      } catch (e: any) {
        signedVttError = e.message;
      }
    }

    // Try signed HLS manifest (to verify token works)
    let hlsPreview: string | null = null;
    let hlsError: string | null = null;
    if (signedVttUrl) {
      const signedBase = signedVttUrl.replace(/\/captions\/.*/, "");
      const hlsUrl = `${signedBase}/manifest/video.m3u8`;
      try {
        const resp = await fetch(hlsUrl);
        const text = await resp.text();
        if (resp.ok) {
          hlsPreview = text.substring(0, 300);
          // Check if manifest references VTT
          if (text.includes("vtt") || text.includes("SUBTITLES")) {
            hlsPreview += " [vtt-referenced]";
          }
        } else {
          hlsError = `HTTP ${resp.status}: ${text.substring(0, 200)}`;
        }
      } catch (e: any) {
        hlsError = e.message;
      }
    }

    return Response.json({
      videoId,
      customerCode,
      publicVttUrl,
      signedVttUrl,
      binding: bindingCaptions,
      bindingError,
      vttPreview,
      vttError,
      signedVttPreview,
      signedVttError,
      hlsPreview,
      hlsError,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// ════════════════════════════════════════════════════════
//  GET /videos — Diagnostic: list Stream videos
// ════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════
//  POST /index — Publish handler
// ════════════════════════════════════════════════════════

async function handleIndex(body: IndexRequest, env: Env): Promise<Response> {
  const { event, org_id, entity } = body;
  if (!event)
    return Response.json({ error: "Missing event" }, { status: 400 });
  if (!org_id)
    return Response.json({ error: "Missing org_id" }, { status: 400 });
  if (!entity)
    return Response.json({ error: "Missing entity" }, { status: 400 });

  if (event !== "publish") {
    return Response.json({ error: "Unknown event" }, { status: 400 });
  }

  // ── Video lesson ──
  if (entity.contentType === "video") {
    return handleVideoIndex(entity, org_id, env);
  }

  // ── Text lesson (or fallback) — metadata-only upload ──
  const content = buildMetadataContent(entity);
  try {
    const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
    if (!instance) {
      return Response.json(
        { error: `AI Search instance '${org_id}-lessons' not found` },
        { status: 500 }
      );
    }
    await instance.items.upload(
      `lesson-${entity.id}.json`,
      JSON.stringify({
        content,
        metadata: {
          title: entity.title,
          lesson_id: entity.id,
          course_id: entity.course_id,
          module_id: entity.module_id,
          org_id,
          content_type: entity.contentType || "unknown",
          duration_seconds: entity.durationSeconds,
          transcript_source: "none",
        },
      })
    );

    return Response.json({
      status: "indexed",
      transcript_source: "none",
      content_length: content.length,
    });
  } catch (err: any) {
    return Response.json(
      { error: `Indexing failed: ${err.message}` },
      { status: 500 }
    );
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
    return Response.json(
      { error: "Missing cloudflareVideoId for video lesson" },
      { status: 400 }
    );
  }

  // Step 1: Check if video is ready
  if (entity.streamStatus !== "ready") {
    return Response.json({
      status: "queued",
      reason: "video_not_ready",
      videoId,
    }, { status: 202 });
  }

  try {
    // Step 2: Check existing captions via Stream binding
    const video = env.STREAM.video(videoId);
    let captions: any[];
    let transcriptSource: string;

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

    if (enCaption) {
      // Step 3a: Captions already exist → fetch VTT directly
      console.log(`Video ${videoId}: using existing captions, language=${enCaption.language}`);
      const vtt = await fetchStreamVTT(videoId, enCaption.language, env);
      transcript = extractTextFromVTT(vtt);
      transcriptSource = "existing";
    } else {
      // Step 3b: Generate captions via AI
      console.log(`Video ${videoId}: generating AI captions...`);
      await video.captions.generate("en");

      // Poll until ready (max 60 seconds)
      transcript = await pollForCaptions(videoId, video, env);
      transcriptSource = "ai_generated";
    }

    // Step 4: Upload transcript to AI Search
    const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
    if (!instance) {
      return Response.json(
        { error: `AI Search instance '${org_id}-lessons' not found` },
        { status: 500 }
      );
    }

    await instance.items.upload(
      `lesson-${entity.id}.json`,
      JSON.stringify({
        content: transcript,
        metadata: {
          title: entity.title,
          lesson_id: entity.id,
          course_id: entity.course_id,
          module_id: entity.module_id,
          org_id,
          content_type: "video",
          duration_seconds: entity.durationSeconds,
          transcript_source: transcriptSource,
        },
      })
    );

    return Response.json({
      status: "indexed",
      transcript_source: transcriptSource,
      content_length: transcript.length,
    });
  } catch (err: any) {
    // Fallback: metadata-only upload on caption failure
    console.error(`Video ${videoId} captioning failed: ${err.message}, using metadata fallback`);

    try {
      const content = buildMetadataContent(entity);
      const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
      if (instance) {
        await instance.items.upload(
          `lesson-${entity.id}.json`,
          JSON.stringify({
            content,
            metadata: {
              title: entity.title,
              lesson_id: entity.id,
              course_id: entity.course_id,
              module_id: entity.module_id,
              org_id,
              content_type: "video",
              duration_seconds: entity.durationSeconds,
              transcript_source: "none",
            },
          })
        );
      }
    } catch {
      // swallow — already returning error below
    }

    return Response.json({
      status: "fallback",
      transcript_source: "none",
      content_length: buildMetadataContent(entity).length,
      error: err.message,
    });
  }
}

/**
 * Poll for captions to be ready. Caps at ~60 seconds.
 */
async function pollForCaptions(
  videoId: string,
  video: any,
  env: Env
): Promise<string> {
  const maxAttempts = 20; // 20 × 3s = 60s max
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

      // Check for errors
      const errored = captions.find(
        (c: any) => c.status === "error"
      );
      if (errored) {
        throw new Error(`Caption generation failed: ${errored.error || "unknown error"}`);
      }
    } catch (err: any) {
      // Don't retry on VTT fetch errors — the caption might still be generating
      if (err.message?.includes("Failed to fetch VTT")) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Caption generation timed out after ${maxAttempts * 3}s`);
}

/** Build a short metadata-only content string for non-video lessons. */
function buildMetadataContent(entity: IndexRequest["entity"]): string {
  const type = entity.contentType || "lesson";
  const duration = entity.durationSeconds ? `Duration: ${entity.durationSeconds}s.` : "";
  return `${entity.title}. ${type}. ${duration}`.trim().replace(/\s+/g, " ");
}

// ════════════════════════════════════════════════════════
//  POST /deindex — Unpublish handler
// ════════════════════════════════════════════════════════

async function handleDeindex(
  body: IndexRequest,
  env: Env
): Promise<Response> {
  const { org_id, entity } = body;
  try {
    const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
    if (!instance) {
      return Response.json(
        { error: `AI Search instance '${org_id}-lessons' not found` },
        { status: 500 }
      );
    }
    await instance.items.delete(`lesson-${entity.id}.json`);
    return Response.json({ status: "deindexed" });
  } catch (err: any) {
    return Response.json(
      { error: `Deindex failed: ${err.message}` },
      { status: 500 }
    );
  }
}

// ════════════════════════════════════════════════════════
//  POST /backfill — Bulk re-index
// ════════════════════════════════════════════════════════

async function handleBackfill(
  body: BackfillRequest,
  env: Env
): Promise<Response> {
  if (!body.org_id) {
    return Response.json({ error: "Missing org_id" }, { status: 400 });
  }

  const videos = await env.STREAM.videos.list();
  let queued = 0;
  let skipped = 0;

  for (const video of videos) {
    if (video.status?.state === "ready") {
      queued++;
    } else {
      skipped++;
    }
  }

  return Response.json({ status: "queued", queued, skipped });
}
