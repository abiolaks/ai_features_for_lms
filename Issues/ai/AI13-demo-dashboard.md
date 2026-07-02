GitHub Issue: [#7](https://github.com/datazone-ai/ai_features_for_lms/issues/7)

# AI13: Demo Dashboard

- **Type:** AFK
- **Week:** 1-5 (cumulative — built across all waves)
- **Blocked by:** Each slice it demonstrates
- **PR target:** ~50-80 lines per wave

## What to build

A single-page dashboard that proves every AI feature works end-to-end with real LMS data. Built incrementally — each PR that delivers a slice also adds its card to this dashboard.

**Tech:** Cloudflare Pages. Static HTML + vanilla JS. Calls AI Workers directly.

### Wave Structure

**Week 1 (AI03):** Shell page + AI03 Gateway card
- Shows: Workers AI connection status, budget usage, model health
- Card: "LLM Gateway — Connected to Llama 3.2 / Mistral. Budget: 45,230 / 1,000,000 tokens."

**Week 2 (AI01):** Indexing card
- Shows: Indexed lessons count, AI Search instance status, webhook events
- Card: "Indexed 3 lessons (142 chunks). AI Search status: Active. Last webhook: 2 min ago."

**Week 3 (AI04+AI08):** Tutor + Insights cards
- Shows: Tutor Q&A demo, sample insight from real quiz
- Card: "Ask a question about Python Functions: [_____] [Ask]"
- Card: "Latest Quiz Insight: You scored 75% on Data Types..."

**Week 4 (AI06):** Learning Paths card
- Shows: Generated path from real learner profile
- Card: "Your Learning Path: 1. Python Fundamentals → 2. Data Structures → 3. Web Scraping"

**Week 5 (AI07):** Recommendations card + polish
- Shows: Enhanced recommendations with AI explanations
- Card: "Recommended for You: Advanced Python — because you mastered all prerequisites..."

### Shared Components

- Progress tracker bar (% of AI features complete)
- Status indicator per feature (green/yellow/red)
- Error states (graceful degradation display)

## Acceptance criteria

- [ ] Dashboard loads at deployed Pages URL
- [ ] Week 1: Shell + AI03 card shows live budget/model data
- [ ] Week 2: AI01 card shows indexed content + AI Search instance status
- [ ] Week 3: AI04 tutor demo returns real cited answers; AI08 shows real insight
- [ ] Week 4: AI06 generates path from real LMS data
- [ ] Week 5: AI07 shows recommendations with AI explanations
- [ ] Each new card doesn't break existing cards
- [ ] All cards handle error states (AI Worker down → card shows degraded state)
- [ ] Progress tracker reflects current completion
- [ ] **Observability:** Health metrics cards added weekly (groundedness, latency, budget usage)
- [ ] **Observability:** Each card shows degraded state when its AI Worker is unreachable
