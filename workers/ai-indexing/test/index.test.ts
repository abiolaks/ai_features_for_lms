import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker, { extractTextFromVTT } from '../src/index';

// ──── Mock Stream + AI + Vectorize bindings ────

function mockStreamVideo() {
  return {
    captions: {
      list: vi.fn().mockResolvedValue([]),
      generate: vi.fn().mockResolvedValue({ status: 'inprogress' }),
    },
  };
}

beforeAll(() => {
  (env as any).STREAM = {
    video: vi.fn().mockReturnValue(mockStreamVideo()),
    videos: {
      list: vi.fn().mockResolvedValue([]),
    },
  };

  // Workers AI: returns a mock 384-dim embedding vector
  (env as any).AI = {
    run: vi.fn().mockResolvedValue({ data: [new Array(384).fill(0.1)] }),
  };

  // Vectorize: mock upsert + delete
  (env as any).VECTORIZE_INDEX = {
    upsert: vi.fn().mockResolvedValue(undefined),
    getByIds: vi.fn().mockResolvedValue([]),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
  };

  // Webhook secret for auth validation
  (env as any).LMS_WEBHOOK_SECRET = "test-whsec";
});

// ──── Helpers ────

function buildRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': 'test-whsec',
    },
    body: JSON.stringify(body),
  });
}

async function callWorker(path: string, body: unknown) {
  const req = buildRequest(path, body);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════

describe('Validation', () => {
  it('rejects GET requests', async () => {
    const req = new Request('http://localhost/index', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
  });

  it('rejects missing X-Webhook-Secret', async () => {
    const req = new Request('http://localhost/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'publish', org_id: 'test', entity: { id: '1' } }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('rejects wrong X-Webhook-Secret', async () => {
    const req = new Request('http://localhost/index', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': 'wrong-secret',
      },
      body: JSON.stringify({ event: 'publish', org_id: 'test', entity: { id: '1' } }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('rejects unknown paths', async () => {
    const res = await callWorker('/unknown', { event: 'publish' });
    expect(res.status).toBe(404);
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('http://localhost/index', {
      method: 'POST',
      headers: {
        'X-Webhook-Secret': 'test-whsec',
      },
      body: 'not json',
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('rejects missing event on /index', async () => {
    const res = await callWorker('/index', {
      org_id: 'org-test',
      entity: { id: 'lesson-1', title: 'Test' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing org_id on /index', async () => {
    const res = await callWorker('/index', {
      event: 'publish',
      entity: { id: 'lesson-1', title: 'Test' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing entity on /index', async () => {
    const res = await callWorker('/index', {
      event: 'publish',
      org_id: 'org-test',
    });
    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════
//  VTT Parsing
// ════════════════════════════════════════════════════════

describe('extractTextFromVTT', () => {
  it('extracts clean text from WebVTT', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:05.240',
      'Welcome to Python fundamentals.',
      '',
      '00:00:05.240 --> 00:00:12.800',
      "Today we'll cover variables and data types.",
      '',
    ].join('\n');

    const result = extractTextFromVTT(vtt);
    expect(result).toBe(
      "Welcome to Python fundamentals. Today we'll cover variables and data types.",
    );
  });

  it('handles empty VTT', () => {
    expect(extractTextFromVTT('WEBVTT\n')).toBe('');
  });

  it('handles VTT with cue numbers', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:03.000',
      'First cue.',
      '',
      '2',
      '00:00:03.000 --> 00:00:06.000',
      'Second cue.',
    ].join('\n');

    const result = extractTextFromVTT(vtt);
    expect(result).toBe('First cue. Second cue.');
  });

  it('normalizes whitespace', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:03.000',
      '  Hello    world  ',
    ].join('\n');

    expect(extractTextFromVTT(vtt)).toBe('Hello world');
  });
});

// ════════════════════════════════════════════════════════
//  POST /index — text lesson
// ════════════════════════════════════════════════════════

describe('POST /index — text lesson', () => {
  it('queues text content for indexing', async () => {
    const res = await callWorker('/index', {
      event: 'publish',
      org_id: 'org-test',
      entity: {
        id: 'lesson-text-1',
        title: 'Reading: Python History',
        contentType: 'text',
        course_id: 'course-1',
        durationSeconds: 300,
      },
    });

    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.status).toBe('queued');
  });
});

// ════════════════════════════════════════════════════════
//  POST /index — video lesson
// ════════════════════════════════════════════════════════

describe('POST /index — video lesson', () => {
  it('queues when video is not ready', async () => {
    const res = await callWorker('/index', {
      event: 'publish',
      org_id: 'org-test',
      entity: {
        id: 'lesson-vid-1',
        title: 'Processing Video',
        contentType: 'video',
        cloudflareVideoId: 'abc123',
        streamStatus: 'processing',
      },
    });

    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.status).toBe('queued');
  });
});

// ════════════════════════════════════════════════════════
//  POST /deindex
// ════════════════════════════════════════════════════════

describe('POST /deindex', () => {
  it('deletes from Vectorize', async () => {
    // Return matching vector so cleanup finds it
    (env as any).VECTORIZE_INDEX.getByIds = vi.fn().mockResolvedValue([
      { id: 'lesson-lesson-to-delete', values: [], metadata: {} },
    ]);
    (env as any).VECTORIZE_INDEX.deleteByIds = vi.fn().mockResolvedValue(undefined);

    const res = await callWorker('/deindex', {
      event: 'unpublish',
      org_id: 'org-test',
      entity: { id: 'lesson-to-delete', title: 'Delete Me' },
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('deindexed');
    expect((env as any).VECTORIZE_INDEX.deleteByIds).toHaveBeenCalledWith(['lesson-lesson-to-delete']);
  });
});

// ════════════════════════════════════════════════════════
//  POST /backfill
// ════════════════════════════════════════════════════════

describe('POST /backfill', () => {
  it('queues ready videos for indexing', async () => {
    (env as any).STREAM.videos.list = vi.fn().mockResolvedValue([
      { id: 'vid-1', status: { state: 'ready' } },
      { id: 'vid-2', status: { state: 'processing' } },
      { id: 'vid-3', status: { state: 'ready' } },
    ]);

    const res = await callWorker('/backfill', {
      org_id: 'org-test',
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('queued');
    expect(body.queued).toBe(2);
    expect(body.skipped).toBe(1);
  });

  it('rejects missing org_id', async () => {
    const res = await callWorker('/backfill', {});
    expect(res.status).toBe(400);
  });
});
