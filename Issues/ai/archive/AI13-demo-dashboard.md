# Slice 13: Demo Dashboard

- **Type:** AFK
- **Blocked by (internal):** P00 (needs `lib/ui/` components), P01 (needs Docker + FastAPI static serving)
- **Blocked by (external):** None
- **User stories covered:** (developer tooling — living frontend that grows with every slice)

## Parent

`docs/vertical-slices-phase-1.md` — Phase 1 MVP (developer enablement)

## What to build

A cumulative demo dashboard — a single HTML file served by a tiny FastAPI static server. Starts as a blank shell. As each slice ships, a new card/tab is added to the dashboard. This gives a clickable end-to-end view of what's built so far and doubles as a manual integration test harness.

**Tech:** TypeScript compiled to ES modules. All UI components come from `lib/ui/` (P00) — `<lms-card>`, `<lms-tabs>`, `<lms-button>`, `<lms-badge>`, `<lms-spinner>`. Layout via `.lms-card-grid` for responsive card flow. No framework, no build step beyond `tsc`.

Open `http://localhost:8002` and everything is there.

**Architecture:**
```
dashboard/
├── index.html          # Shell with <lms-tabs> + .lms-card-grid
├── app.ts              # Card registry + service URL config
└── cards/
    ├── mock-platform.ts    # Slice 00 card
    ├── indexing.ts         # Slice AI01a+AI01b card
    ├── retrieval.ts        # Slice AI02 card
    ├── gateway.ts          # Slice AI03 card
    ├── tutor.ts            # Slice AI04a+AI04b card
    ├── profile.ts          # Slice AI05 card
    ├── paths.ts            # Slice AI06 card
    ├── recommendations.ts  # Slice AI07 card
    ├── insights.ts         # Slice AI08 card
    ├── assistant.ts        # Slice AI09 card
    ├── assessments.ts      # Slice AI10a+AI10b card
    ├── quality.ts          # Slice AI11 card
    └── degradation.ts      # Slice AI12 card
```

Each card file is ~30-80 lines of TypeScript. It registers a card by creating an `<lms-card>` element with a form and a result pane. All styling comes from `lib/ui/` design tokens.

### How cards work

Every card follows the same pattern:

```typescript
// cards/gateway.ts — Slice AI03 card
// Shows LLM Gateway prompt → response with token count and tier.

import { api } from '../../lib/ui/api.ts';

export function register(container: HTMLElement) {
  const card = document.createElement('lms-card');
  card.setAttribute('title', 'LLM Gateway');
  card.setAttribute('badge', 'Slice AI03');

  card.innerHTML = `
    <form id="gateway-form">
      <lms-form-group label="Prompt">
        <textarea name="prompt" placeholder="Enter a prompt..." required></textarea>
      </lms-form-group>
      <lms-form-group label="Model Tier">
        <select name="tier">
          <option value="standard">Standard (fast)</option>
          <option value="quality">Quality (capable)</option>
        </select>
      </lms-form-group>
      <lms-button type="submit" variant="primary">Generate</lms-button>
    </form>
    <pre id="gateway-result" class="result"></pre>
  `;

  container.appendChild(card);

  card.querySelector('form')!.onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    const data = await api('/api/ai/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt: form.get('prompt'),
        tier: form.get('tier'),
        org_id: 'org-a',
      }),
    });
    card.querySelector('#gateway-result')!.textContent = JSON.stringify(data, null, 2);
  };
}

### Cumulative rollout (built from wave 1, not at the end)

The dashboard ships in wave 1 with two things:
- **Progress tab** — always present, shows build status
- **Empty feature tabs** — "Platform" and "AI" tabs that fill up as slices land

**Each PR adds its card.** The developer building a slice also adds the dashboard card for it. No separate "add UI later" phase.

**Always present (from wave 1):**

| Tab | What it shows |
|-----|--------------|
| **Progress** | `<lms-progress-tracker>` — reads `Issues/status.json`. Overall %, wave breakdown with 🟢/🟡/⚪ dots. |

**Platform features (added as P-slices complete):**

| Slice | Card | What you can click and see |
|-------|------|---------------------------|
| P03 | Content browser | Table of courses → expand to see modules/lessons with content |
| P05 | Learner registration | Register form → get API key → copy to clipboard |
| P06 | Course catalogue | Search/filter courses by difficulty, tag, source |
| P07 | My progress | Enroll in course → mark lessons complete → see progress bar → "what's next" link |
| P08 | Quiz center | Create quiz manually → take quiz → see score → per-question results |
| P10 | Everything unified | All cards now call through `localhost:8000` gateway instead of direct ports |

**AI features (added as AI-slices complete):**

| Slice | Card | What you can click and see |
|-------|------|---------------------------|
| AI01a+AI01b | Content indexer | Paste text → chunk → embed → index into LanceDB → search → de-index |
| AI02 | RAG retrieval | Type query, pick scope, see ranked chunks with relevance scores |
| AI03 | LLM Gateway | Type prompt, pick tier, see response + token count + budget gauge |
| AI04a+AI04b | In-Lesson Tutor | Chat interface — ask about lesson content → cited answer with timestamps |
| AI05 | Learner profile | Add skills (typeahead from taxonomy), goals, experience level |
| AI06 | Learning paths | Click "Generate Path" → see ordered courses with "why this fits you" |
| AI07 | Recommendations | Three sections: For You top-3, Because You Completed, What's Next |
| AI08 | Quiz insights | Submit quiz → see coaching message with review links for missed topics |
| AI09 | Platform assistant | "How far am I?" → progress. Content question → handoff to Tutor |
| AI10a+AI10b | Assessment generator | Generate N questions → approve/reject/edit → see source traces |
| AI11 | Quality check | Run checks → see duplicate flags + reading level mismatches |
| AI12 | Degradation toggle | Flip "LLM Gateway: OFF" → all AI cards show degraded state → flip back on |

### Service URL configuration

The dashboard reads service URLs from a single config object at the top of `app.ts`. All services are behind the platform gateway (P10) on port 8000:

```typescript
// app.ts
const API_BASE = 'http://localhost:8000';

// All API calls go through the gateway:
//   /api/content/*    → Content Management (P03)
//   /api/accounts/*   → Learner Accounts (P05)
//   /api/catalogue/*  → Course Catalogue (P06)
//   /api/progress/*   → Enrollment & Progress (P07)
//   /api/quizzes/*    → Quiz Engine (P08)
//   /api/ai/*         → AI services (future)
};
```

### Docker Compose

The dashboard and all services come up together:

```yaml
# docker-compose.yml (cumulative — services added as slices ship)
services:
  mock-platform:
    build: ./services/mock-platform
    ports: ["8001:8001"]
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    ports: ["10000:10000"]
  chunking:
    build: ./services/chunking
    ports: ["8010:8010"]
  # ... more services added here as slices ship
  dashboard:
    build: ./dashboard
    ports: ["8002:8002"]
    environment:
      - SERVICES_CONFIG=/app/services.json
```

## Acceptance criteria

- [ ] Dashboard loads at `http://localhost:8002` with `<lms-tabs>` and responsive card grid
- [ ] **Progress tab** is always present from day 0 — reads `status.json`, renders `<lms-progress-tracker>`
- [ ] Progress tracker shows: overall completion bar, platform wave breakdown, AI wave breakdown
- [ ] Progress tracker auto-refreshes on page load (no polling needed — update `status.json` per PR)
- [ ] Each card is a self-contained `.ts` file under `dashboard/cards/` that exports a `register(container)` function
- [ ] Cards are loaded dynamically at startup
- [ ] When a service is unreachable, the card shows a grey `ai_status: degraded` state instead of crashing
- [ ] All UI components come from `lib/ui/` — no inline styles, no custom CSS per card
- [ ] TypeScript compiles to ES modules with `tsc` — no bundler
- [ ] Service URLs configurable via a single `SERVICES` TypeScript constant
- [ ] Docker Compose starts dashboard + all available services with one command
- [ ] Dashboard doubles as integration test harness — every card makes real HTTP calls
- [ ] Degradation toggle (Slice AI12) visibly changes all AI-dependent card states
- [ ] Type-safe API calls via `lib/ui/api.ts` — compile errors if backend contract changes

## Blocked by

- P00 — needs UI component library (`<lms-card>`, `<lms-tabs>`, `<lms-progress-tracker>`, `<lms-button>`, etc.)
- P01 — needs Docker Compose + FastAPI static serving

**Built incrementally — not at the end.** The dashboard ships in wave 1 as an empty shell with a progress tracker. Each completed slice adds its card in the same PR. This means you always have a working frontend showing what's been built so far.

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
