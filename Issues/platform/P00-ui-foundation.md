# Platform Slice P00: UI Foundation (Design System + Web Components)

- **Type:** AFK
- **Blocked by:** P01 (needs `lib/` directory structure)
- **User stories covered:** (infrastructure — every dashboard inherits this)

## What to build

A zero-dependency, modern, responsive design system that every dashboard in the project uses. Two deliverables:

1. **`lib/ui/` — CSS design tokens + Web Component library** (TypeScript + modern CSS)
2. **Style guide page** — live preview of every component and token

No CSS framework. No JS framework. No build step (TypeScript compiled once, served as static `.js`). Works in every modern browser.

## Tech choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| **Language** | TypeScript | Type-safe DOM APIs, compile to ES2020. No bundler — just `tsc` with `"module": "esnext"`. |
| **Components** | Web Components (custom elements) | Native browser API. `<lms-button>`, `<lms-card>`, `<lms-tabs>`. Encapsulated Shadow DOM. No framework needed. |
| **Layout** | CSS Grid + subgrid | Responsive card grids: `grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))`. No breakpoint hacks. |
| **Tokens** | CSS custom properties | `--lms-color-primary`, `--lms-space-md`, `--lms-radius-lg`. One file, imported everywhere. |
| **Icons** | Inline SVG sprite | One `icons.svg` file, referenced via `<use href="icons.svg#search">`. No icon font CDN. |
| **Font** | System font stack | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, ...` — renders instantly, looks native on every OS. |

## `lib/ui/` structure

```
lib/ui/
├── tokens/
│   ├── colors.css          # Light + dark theme variables
│   ├── spacing.css         # 4px scale (--lms-space-1 through --lms-space-16)
│   ├── typography.css      # Font sizes, weights, line heights
│   └── tokens.ts           # TypeScript constants (for JS-created styles)
├── components/
│   ├── base.ts             # LMSBaseElement — shared superclass
│   ├── lms-button.ts       # <lms-button variant="primary|secondary|danger">
│   ├── lms-card.ts         # <lms-card title="..."> slots content </lms-card>
│   ├── lms-tabs.ts         # <lms-tabs> with <lms-tab-panel> children
│   ├── lms-table.ts        # <lms-table> with sortable columns
│   ├── lms-badge.ts        # <lms-badge variant="success|warning|error">
│   ├── lms-spinner.ts      # <lms-spinner> — loading indicator
│   ├── lms-toast.ts        # <lms-toast-container> + toast() function
│   ├── lms-modal.ts        # <lms-modal> — confirmation dialogs
│   ├── lms-form-group.ts   # <lms-form-group label="..."> — input wrapper
│   ├── lms-progress-tracker.ts  # <lms-progress-tracker> — visual build progress
│   └── icons.svg           # SVG sprite (search, user, book, check, x, etc.)
├── styles/
│   ├── reset.css           # Modern CSS reset
│   ├── layout.css          # .lms-grid, .lms-sidebar-layout, .lms-page-shell
│   └── utilities.css       # .lms-sr-only, .lms-truncate, .lms-visually-hidden
├── lib.ts                  # Re-exports all components + tokens
└── index.html              # Style guide page (live preview of everything)
```

## Design tokens (`tokens/colors.css`)

```css
:root {
  /* Primary — calm blue, professional */
  --lms-color-primary:       #2563eb;
  --lms-color-primary-hover: #1d4ed8;
  --lms-color-primary-light: #dbeafe;

  /* Semantic */
  --lms-color-success:       #16a34a;
  --lms-color-warning:       #d97706;
  --lms-color-error:         #dc2626;
  --lms-color-info:          #0891b2;

  /* Neutrals */
  --lms-color-bg:            #f8fafc;
  --lms-color-surface:       #ffffff;
  --lms-color-border:        #e2e8f0;
  --lms-color-text:          #0f172a;
  --lms-color-text-muted:    #64748b;

  /* Spacing (4px scale) */
  --lms-space-1:  4px;
  --lms-space-2:  8px;
  --lms-space-3:  12px;
  --lms-space-4:  16px;
  --lms-space-6:  24px;
  --lms-space-8:  32px;
  --lms-space-12: 48px;

  /* Typography */
  --lms-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                   'Helvetica Neue', Arial, sans-serif;
  --lms-font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  --lms-font-size-sm:  0.875rem;
  --lms-font-size-base: 1rem;
  --lms-font-size-lg:  1.125rem;
  --lms-font-size-xl:  1.5rem;
  --lms-font-size-2xl: 2rem;

  /* Radii */
  --lms-radius-sm: 4px;
  --lms-radius-md: 8px;
  --lms-radius-lg: 12px;

  /* Shadows */
  --lms-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --lms-shadow-md: 0 4px 6px rgba(0, 0, 0, 0.07);
  --lms-shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);

  /* Transitions */
  --lms-transition: 150ms ease;
}
```

## Example components

### `<lms-card>`
```typescript
// lib/ui/components/lms-card.ts
// A surface container for dashboard widgets. Uses Shadow DOM for style isolation.

import { LMSBaseElement } from './base.ts';

class LMSCard extends LMSBaseElement {
  static styles = `
    :host {
      display: block;
      background: var(--lms-color-surface);
      border: 1px solid var(--lms-color-border);
      border-radius: var(--lms-radius-lg);
      padding: var(--lms-space-6);
      box-shadow: var(--lms-shadow-sm);
      transition: box-shadow var(--lms-transition);
    }
    :host(:hover) {
      box-shadow: var(--lms-shadow-md);
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--lms-space-4);
    }
    .card-title {
      font-size: var(--lms-font-size-lg);
      font-weight: 600;
      color: var(--lms-color-text);
      margin: 0;
    }
    .card-badge {
      font-size: var(--lms-font-size-sm);
      padding: 2px var(--lms-space-2);
      border-radius: var(--lms-radius-sm);
      background: var(--lms-color-primary-light);
      color: var(--lms-color-primary);
    }
  `;

  // Renders when connected to the DOM
  connectedCallback() {
    const title = this.getAttribute('title') || '';
    const badge = this.getAttribute('badge') || '';
    this.shadow.innerHTML = `
      <style>${LMSCard.styles}</style>
      <div class="card-header">
        <h3 class="card-title">${title}</h3>
        ${badge ? `<span class="card-badge">${badge}</span>` : ''}
      </div>
      <slot></slot>
    `;
  }
}
customElements.define('lms-card', LMSCard);
```

Usage in any HTML file:
```html
<lms-card title="LLM Gateway" badge="Slice 03">
  <form>...</form>
  <pre id="result"></pre>
</lms-card>
```

### `<lms-tabs>`
```html
<lms-tabs>
  <lms-tab-panel label="Courses" icon="book">
    <!-- Course management content -->
  </lms-tab-panel>
  <lms-tab-panel label="Learners" icon="user">
    <!-- Learner management content -->
  </lms-tab-panel>
  <lms-tab-panel label="Quizzes" icon="check">
    <!-- Quiz management content -->
  </lms-tab-panel>
</lms-tabs>
```

### `<lms-progress-tracker>`

Visual build progress map. Reads from `Issues/status.json` (checked into the repo) and renders a progress bar + per-wave breakdown of completed, in-progress, and pending slices.

```html
<lms-progress-tracker></lms-progress-tracker>
```

`status.json` format:
```json
{
  "updated": "2026-06-02T14:30:00Z",
  "slices": {
    "P00": { "status": "complete", "merged_at": "2026-06-01" },
    "P01": { "status": "complete", "merged_at": "2026-06-02" },
    "P01b": { "status": "in-progress", "branch": "feat/observability" },
    "P02": { "status": "pending" }
  }
}
```

The component renders:
- **Progress bar** — overall completion (e.g., "4 of 29 complete — 13.8%")
- **Platform section** — wave-by-wave list with colored status dots:
  - 🟢 Complete (green badge + merge date)
  - 🟡 In Progress (yellow badge + branch name)
  - ⚪ Pending (grey)
- **AI section** — same wave-by-wave list
- **Last updated** timestamp at the bottom

When a slice is merged, update `status.json` in the same PR. The dashboard auto-refreshes on load.

### Responsive card grid

```css
/* lib/ui/styles/layout.css */
.lms-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--lms-space-6);
  padding: var(--lms-space-6);
}

/* On narrow screens, cards go full-width */
@media (max-width: 400px) {
  .lms-card-grid {
    grid-template-columns: 1fr;
  }
}
```

## Style guide page (`lib/ui/index.html`)

Served at `http://localhost:8005` (or `/ui/` on the gateway). Shows every component with copy-paste HTML snippets, token swatches, and a responsive preview toggle (phone/tablet/desktop).

## TypeScript shared API types

```typescript
// lib/ui/api.ts
// Shared API types — guarantees frontend/backend contract.

export interface Course {
  id: string;
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  source: string;
  tags: string[];
  module_count: number;
  lesson_count: number;
}

export interface APIResponse<T> {
  data: T;
  error: null | { type: string; message: string };
}

// Typed fetch wrapper used by all dashboard pages
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  const json: APIResponse<T> = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.data;
}
```

## How dashboards consume this

P09 (Admin Dashboard) imports the component library:
```html
<!-- services/admin/static/index.html -->
<link rel="stylesheet" href="/lib/ui/tokens/colors.css">
<link rel="stylesheet" href="/lib/ui/tokens/spacing.css">
<link rel="stylesheet" href="/lib/ui/styles/layout.css">
<script type="module" src="/lib/ui/lib.js"></script>
```

AI13 (Demo Dashboard) does the same. Both get responsive layout, consistent design tokens, and type-safe API calls for free.

## Acceptance criteria

- [ ] `lib/ui/tokens/` — 4 CSS files (colors, spacing, typography, tokens.ts) with documented variables
- [ ] `lib/ui/styles/reset.css` — minimal reset, no scrollbar hacks, respects `prefers-reduced-motion`
- [ ] `lib/ui/styles/layout.css` — `.lms-card-grid` responsive (auto-fit, minmax)
- [ ] `<lms-card>` — renders with title, badge, content slot; hover shadow; responsive
- [ ] `<lms-tabs>` — keyboard-navigable (arrow keys), aria roles, responsive (stacks on mobile)
- [ ] `<lms-button>` — 3 variants (primary, secondary, danger), disabled state, loading state
- [ ] `<lms-table>` — sortable columns (click header), striped rows, responsive (horizontal scroll)
- [ ] `<lms-badge>` — 3 variants (success, warning, error)
- [ ] `<lms-spinner>` — CSS-only animation (no GIF), `prefers-reduced-motion` support
- [ ] `<lms-progress-tracker>` — reads `status.json`, renders progress bar + wave-by-wave status list with colored dots
- [ ] `<lms-toast>` — auto-dismiss after 4s, stacked, accessible (role="alert")
- [ ] `<lms-modal>` — focus trap, escape to close, backdrop click to close
- [ ] All components extend `LMSBaseElement` (handles Shadow DOM + adopted stylesheets)
- [ ] `lib/ui/api.ts` — typed `api<T>()` wrapper, Course/Learner/Quiz response types
- [ ] Style guide at `http://localhost:8005/lib/ui/` shows every component with HTML snippets
- [ ] Zero external dependencies — no npm packages beyond TypeScript compiler
- [ ] TypeScript compiles to ES2020 with `tsc` — no bundler, no minifier needed
- [ ] Works in Chrome, Firefox, Safari (latest 2 versions)
- [ ] Unit tests: each component renders, responds to attribute changes, emits events

## Blocked by

- P01 — needs `lib/` directory and FastAPI static file serving

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
