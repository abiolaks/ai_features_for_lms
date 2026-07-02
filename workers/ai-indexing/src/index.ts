// ============================================================
// AI01: Content Indexing Worker
// ============================================================

export interface Env {
  STREAM: any;
  AI_SEARCH: any;
  INDEXING_QUEUE: Queue;
  LMS_WEBHOOK_SECRET: string;
}

interface IndexRequest {
  event: 'publish' | 'update' | 'unpublish';
  org_id: string;
  entity: {
    id: string;
    title: string;
    contentType: 'video' | 'text' | 'quiz';
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(req, env);
    } catch (e: any) {
      console.error('Worker error:', e.message, e.stack);
      return json({ error: 'internal_error', message: e.message }, 500);
    }
  },
};

async function handleRequest(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const url = new URL(req.url);
  const path = url.pathname;

  let body: any;
  try { body = await req.json(); } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  switch (path) {
    case '/index':   return handleIndex(body, env);
    case '/deindex': return handleDeindex(body, env);
    case '/backfill': return handleBackfill(body, env);
    default:         return json({ error: 'not_found' }, 404);
  }
}

// ──── Index ────

async function handleIndex(req: IndexRequest, env: Env): Promise<Response> {
  const { event, org_id, entity } = req;

  if (!event || !['publish', 'update'].includes(event))
    return json({ error: 'invalid_event' }, 400);
  if (!org_id) return json({ error: 'missing_field', field: 'org_id' }, 400);
  if (!entity?.id) return json({ error: 'missing_field', field: 'entity.id' }, 400);
  if (!entity?.title) return json({ error: 'missing_field', field: 'entity.title' }, 400);

  const isVideo = entity.contentType === 'video' && entity.cloudflareVideoId;
  let transcript: string | null = null;
  let transcriptSource: 'existing' | 'ai_generated' | 'none' = 'none';

  if (isVideo && entity.cloudflareVideoId) {
    if (entity.streamStatus !== 'ready') {
      return json({ status: 'queued', reason: 'video_not_ready' }, 202);
    }
    try {
      transcript = await extractTranscript(entity.cloudflareVideoId, env);
      transcriptSource = transcript ? 'existing' : 'none';
    } catch (err: any) {
      console.error(`Caption extraction failed: ${err.message}`);
    }
  }

  const content = transcript || buildMetadataContent(entity);
  if (!transcript) transcriptSource = 'none';

  await uploadToAiSearch(env, org_id, entity, content, transcriptSource);

  return json({
    status: 'indexed',
    entity_id: entity.id,
    transcript_source: transcriptSource,
    content_length: content.length,
  }, 200);
}

// ──── Deindex ────

async function handleDeindex(req: IndexRequest, env: Env): Promise<Response> {
  const { org_id, entity } = req;
  if (!org_id) return json({ error: 'missing_field', field: 'org_id' }, 400);
  if (!entity?.id) return json({ error: 'missing_field', field: 'entity.id' }, 400);

  const instance = env.AI_SEARCH.get(`${org_id}-lessons`);
  await instance.items.delete(`lesson-${entity.id}.json`);
  return json({ status: 'deindexed', entity_id: entity.id }, 200);
}

// ──── Backfill ────

async function handleBackfill(req: BackfillRequest, env: Env): Promise<Response> {
  if (!req.org_id) return json({ error: 'missing_field', field: 'org_id' }, 400);
  const allVideos = await env.STREAM.videos.list({ limit: 100 });
  const ready = allVideos.filter((v: any) => v.status?.state === 'ready');
  for (const video of ready) {
    await env.INDEXING_QUEUE.send({ type: 'lesson', id: video.id, org_id: req.org_id, action: 'index' });
  }
  return json({ status: 'queued', queued: ready.length, total: allVideos.length, skipped: allVideos.length - ready.length }, 200);
}

// ──── Transcript Extraction ────

async function extractTranscript(videoId: string, env: Env): Promise<string | null> {
  const videoHandle = env.STREAM.video(videoId);

  // 1. Check for existing captions
  const captions: any[] = await videoHandle.captions.list();
  const enCaption = captions.find((c: any) => c.language === 'en' && c.status === 'ready');

  if (enCaption) {
    const customerCode = await getCustomerCode(videoId, env);
    const vttUrl = `https://customer-${customerCode}.cloudflarestream.com/${videoId}/captions/en`;
    const response = await fetch(vttUrl);
    if (response.ok) {
      const vtt = await response.text();
      return extractTextFromVTT(vtt);
    }
  }

  // 2. Generate captions if none exist
  await videoHandle.captions.generate('en');

  // 3. Poll for up to 30 seconds
  const customerCode = await getCustomerCode(videoId, env);
  const vttUrl = `https://customer-${customerCode}.cloudflarestream.com/${videoId}/captions/en`;

  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    try {
      const response = await fetch(vttUrl);
      if (response.ok) {
        const vtt = await response.text();
        return extractTextFromVTT(vtt);
      }
    } catch { /* still generating */ }
  }

  return null;
}

async function getCustomerCode(videoId: string, env: Env): Promise<string> {
  const details = await env.STREAM.video(videoId).details();
  const previewUrl: string = details.preview || '';
  const match = previewUrl.match(/customer-([^.]+)\./);
  return match ? match[1] : 'qlr9tw44jcn3803t';
}

// ──── VTT Parsing ────

export function extractTextFromVTT(vtt: string): string {
  return vtt
    .split('\n')
    .filter((line: string) =>
      !line.startsWith('WEBVTT') &&
      !/^\d{2}:/.test(line) &&
      !/^\s*$/.test(line) &&
      !/^\d+$/.test(line),
    )
    .map((line: string) => line.trim())
    .join(' ')
    .replace(/\s+/g, ' ');
}

// ──── AI Search Upload ────

async function uploadToAiSearch(
  env: Env, orgId: string, entity: IndexRequest['entity'],
  content: string, transcriptSource: string,
): Promise<void> {
  const instanceName = `${orgId}-lessons`;

  try {
    await env.AI_SEARCH.create({ id: instanceName });
  } catch (e: any) {
    if (!e.message?.includes('already_exist') && !e.message?.includes('already exist')) {
      throw new Error(`create(${instanceName}): ${e.message}`);
    }
  }

  const instance = env.AI_SEARCH.get(instanceName);
  const body = JSON.stringify({
    content,
    metadata: {
      title: entity.title,
      lesson_id: entity.id,
      course_id: entity.course_id ?? '',
      module_id: entity.module_id ?? '',
      org_id: orgId,
      content_type: entity.contentType ?? 'unknown',
      duration_seconds: entity.durationSeconds ?? 0,
      transcript_source: transcriptSource,
    },
  });

  const encoder = new TextEncoder();
  await instance.items.upload(`lesson-${entity.id}.json`, encoder.encode(body));
}

// ──── Metadata Fallback ────

function buildMetadataContent(entity: IndexRequest['entity']): string {
  return [entity.title, entity.contentType ? `Type: ${entity.contentType}` : '',
    entity.durationSeconds ? `Duration: ${entity.durationSeconds}s` : '']
    .filter(Boolean).join('. ');
}

// ──── Helpers ────

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
