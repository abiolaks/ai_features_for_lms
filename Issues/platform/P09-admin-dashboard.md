# Platform Slice P09: Admin Dashboard

- **Type:** AFK
- **Blocked by:** P03, P05, P06, P08 (needs content + learners + quizzes to display)
- **User stories covered:** Platform — manage courses, view learners, review quiz results

## What to build

A simple admin web UI for managing the LMS. Uses the same pattern as AI13 (Demo Dashboard): single HTML file + vanilla JS (TypeScript compiled to ES modules). Consumes `lib/ui/` design system (P00) for all components —`<lms-card>`, `<lms-tabs>`, `<lms-table>`, `<lms-button>`, `<lms-badge>`. Responsive layout via `.lms-card-grid` and CSS custom properties.

Admin-specific because it calls management endpoints that regular learners can't.

### Service: `services/admin/`

FastAPI app on port `8015` serving static files. No build step.

### Pages (tabs in a single-page app)

| Tab | What it shows | Calls |
|-----|--------------|-------|
| **Courses** | Table of all courses. Click → expand to see modules/lessons. Inline edit title, description, difficulty. Delete with confirmation. | P03 endpoints |
| **Learners** | Table of registered learners. See enrollment counts, last active. Click → learner detail with full progress. | P05, P07 endpoints |
| **Quizzes** | List quizzes by lesson. View questions. See attempt stats (avg score, completion count). | P08 endpoints |
| **Import** | Buttons to trigger ingestion: "Import MIT Courses", "Import YouTube Playlists", "Import Manual Content". Shows last import timestamp and any errors. | P04 scripts via subprocess or HTTP |
| **Tags** | Manage tag taxonomy. Add/delete tags. See which courses use each tag. | P03 tag endpoints |

### Admin auth

Simple: a single admin API key in env var (`ADMIN_API_KEY`). All admin endpoints check this key. No multi-user admin — this is an internal tool for whoever runs the LMS.

### Tech

Consumes `lib/ui/` from P00. No additional styling or components needed — all buttons, cards, tabs, tables, and form controls come from the design system.

```
services/admin/
├── main.py              # FastAPI app serving static files
├── static/
│   ├── index.html       # Single-page shell (TypeScript compiled)
│   └── app.ts           # All tab logic, imports from lib/ui
└── README.md
```

## Acceptance criteria

- [ ] Admin dashboard loads at `http://localhost:8015`
- [ ] Courses tab: lists all courses, click to expand → shows modules/lessons
- [ ] Courses tab: edit course title inline → P03 update called → table refreshes
- [ ] Courses tab: delete course → confirmation dialog → P03 delete called
- [ ] Learners tab: lists all registered learners with enrollment counts
- [ ] Learners tab: click learner → shows enrolled courses and progress
- [ ] Quizzes tab: lists quizzes, shows attempt statistics
- [ ] Import tab: "Import MIT Courses" button triggers P04 → shows result
- [ ] Tags tab: list, add, delete tags
- [ ] Admin key required — wrong key → 401
- [ ] No framework dependencies — single HTML file + vanilla JS
- [ ] Unit tests: admin auth middleware, endpoint routing
- [ ] Integration tests: smoke test each tab loads data from its source service

## Blocked by

- P03 — Content Management (course data)
- P05 — Learner Accounts (learner data)
- P06 — Course Catalogue (optional — can list courses from P03 directly)
- P08 — Quiz Engine (quiz data)

See `Issues/TECH_PRINCIPLES.md` for open-source stack and code principles.
