# AI Features for LMS

AI-powered features for a Learning Management Platform — built with Cloudflare Workers, Workers AI, and Vectorize.

## Architecture

```
LMS (Backend) ──webhooks──→ AI Workers ──→ Vectorize / Workers AI
                                  │
Learner asks ──→ AI Tutor ──→ AI Gateway ──→ LLM (llama-3.2 / mistral-7b)
```

| Worker | Purpose | URL | Tests |
|--------|---------|-----|-------|
| **ai-indexing** | Extracts transcripts from Stream videos, embeds (1024-dim), upserts to Vectorize | `ai-indexing.yomi-alarape.workers.dev` | 16/16 ✅ |
| **ai-tutor** | Grounded Q&A — embeds question, queries Vectorize, builds prompt, calls LLM | `ai-tutor.yomi-alarape.workers.dev` | 15/15 ✅ |
| **ai-gateway** | Internal LLM router — model selection, token budgeting, D1 tracking | `ai-gateway.yomi-alarape.workers.dev` | 14/14 ✅ |
| ai-recommendations | Course recommendations with fallback cascade | ⬜ upcoming |
| ai-paths | Personalized learning path generation | ⬜ upcoming |
| ai-insights | Post-quiz insights with review links | ⬜ upcoming |
| ai-dashboard | Demo dashboard for all AI features | ⬜ upcoming |

## How It Works

### Content Indexing

```
LMS publishes a course → webhook → ai-indexing
  → Fetches video transcript from Cloudflare Stream (VTT → clean text)
  → Embeds with @cf/qwen/qwen3-embedding-0.6b (1024-dim)
  → Upserts to Vectorize index "lms-lessons"
  → Content is instantly searchable
```

### AI Tutor

```
Learner asks question → ai-tutor
  → Embeds question (same model, 1024-dim)
  → Queries Vectorize for similar content in their lesson
  → Builds grounded prompt with transcript excerpts
  → Calls AI Gateway (llama-3.2) with strict grounding instructions
  → Returns cited answer with source lesson title + excerpt
```

## Tech Stack

- **Runtime:** Cloudflare Workers (TypeScript)
- **AI:** Workers AI (`@cf/qwen/qwen3-embedding-0.6b`, `@cf/meta/llama-3.2-3b-instruct`)
- **Vector DB:** Cloudflare Vectorize (1024-dim, cosine metric)
- **LLM Gateway:** Service binding → ai-gateway worker
- **Video:** Cloudflare Stream (caption extraction via REST API)
- **Testing:** Vitest + `@cloudflare/vitest-pool-workers`
- **Database:** D1 (`lms-platform`) for token budgets
- **Cache:** KV (`LMS_CACHE`) for response caching

## Project Structure

```
├── workers/
│   ├── shared/           # Types + LMS API client
│   ├── ai-gateway/       # AI03 — LLM Gateway ✅
│   ├── ai-indexing/      # AI01 — Content Indexing ✅
│   ├── ai-tutor/         # AI04 — Grounded Q&A ✅
│   ├── ai-recommendations/  # AI07
│   ├── ai-paths/            # AI06
│   ├── ai-insights/         # AI08
│   └── ai-dashboard/        # AI13
├── Issues/
│   ├── ai/               # Active issues (linked to GitHub)
│   ├── ai/done/          # Completed issues
│   └── ai/archive/       # Archived / superseded
├── docs/
│   ├── lms-api-contract-for-backend.md   # THE authoritative API contract
│   └── ...
├── knowledge.md          # Session knowledge base
├── blockers-and-resolutions.md  # All blockers + fixes
├── notes-steps-implementation.md # Chronological build log
└── progress.txt          # Current project state
```

## API Contract

See [docs/lms-api-contract-for-backend.md](docs/lms-api-contract-for-backend.md) for the complete backend engineer handoff — request/response shapes, error codes, and scope expansion flow.

Quick reference:

```bash
# Index a lesson
POST https://ai-indexing.yomi-alarape.workers.dev/index
Body: { event, org_id, entity: { id, title, contentType, cloudflareVideoId, streamStatus, course_id } }

# Remove a lesson
POST https://ai-indexing.yomi-alarape.workers.dev/deindex
Body: { event, org_id, entity: { id } }

# Ask the tutor
POST https://ai-tutor.yomi-alarape.workers.dev/tutor/ask
Body: { question, lesson_id, course_id, org_id }
Response: { answer, citations: [{ lesson_title, excerpt, score }], scope_expansion_suggested }
```

## Getting Started

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers Paid plan
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
# Clone and install deps for each worker
cd workers/ai-indexing && npm install
cd workers/ai-tutor && npm install
# ... repeat for each worker

# Set secrets (per worker)
npx wrangler secret put CLOUDFLARE_STREAM_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID

# Deploy
npx wrangler deploy

# Run tests
npx vitest run
```

### Required Infrastructure

| Resource | Type | Status |
|----------|------|--------|
| `lms-lessons` | Vectorize index (1024-dim) | ✅ Created |
| `lms-platform` | D1 database | ✅ Created |
| `LMS_CACHE` | KV namespace | ✅ Created |
| `indexing-jobs` | Queue | ✅ Created |
| Stream videos | Cloudflare Stream | ✅ 8 videos available |

## Secrets

| Secret | Worker | Status |
|--------|--------|--------|
| `CLOUDFLARE_STREAM_API_TOKEN` | ai-indexing | ✅ Set |
| `CLOUDFLARE_ACCOUNT_ID` | ai-indexing | ✅ Set |
| `LMS_WEBHOOK_SECRET` | ai-indexing | ⬜ When LMS live |
| `LMS_GATEWAY_URL` | ai-tutor | ⬜ When LMS live |
| `LMS_INTERNAL_KEY` | ai-tutor | ⬜ When LMS live |

## Issues

All work is tracked as GitHub Issues and mirrored locally in `Issues/ai/`.

- [#4](https://github.com/datazone-ai/ai_features_for_lms/issues/4) AI06: Learning Paths
- [#5](https://github.com/datazone-ai/ai_features_for_lms/issues/5) AI07: Recommendations
- [#6](https://github.com/datazone-ai/ai_features_for_lms/issues/6) AI08: Post-Quiz Insights
- [#7](https://github.com/datazone-ai/ai_features_for_lms/issues/7) AI13: Demo Dashboard
- [#11](https://github.com/datazone-ai/ai_features_for_lms/issues/11) F01: CV Parsing
- [#12](https://github.com/datazone-ai/ai_features_for_lms/issues/12) F02: Mentor Matching
- [#13](https://github.com/datazone-ai/ai_features_for_lms/issues/13) F03: Skill-Gap Analysis
- [#14](https://github.com/datazone-ai/ai_features_for_lms/issues/14) F04: Org Plan Tuning
- [#15](https://github.com/datazone-ai/ai_features_for_lms/issues/15) F05: Admin Analytics
