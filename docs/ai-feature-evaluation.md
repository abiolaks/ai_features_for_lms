# AI Feature Evaluation Framework

> How to measure quality, correctness, and performance for every AI feature in the LMS. All evals run on Cloudflare Workers.

---

## Evaluation Strategy Overview

Two layers, different purposes:

| Layer | When | What It Measures | Cost |
|---|---|---|---|
| **Offline eval** | CI pipeline, before deploy | Objective correctness (did the model hallucinate? is the order right?) | Cheap — runs on test fixtures |
| **Online eval** | Sampling in production | Subjective quality (is the answer helpful? is the tone right?) | Expensive — calls another LLM |

---

## AI04a — Tutor Evaluation

### Offline Eval: Groundedness

The tutor must ONLY answer from retrieved content. This is the single most important metric.

```typescript
// tests/tutor-eval.test.ts

const GROUNDEDNESS_TESTS = [
  {
    name: 'answers from retrieved content',
    question: 'What is a Python decorator?',
    retrieved_chunks: [
      'A decorator is a function that wraps another function, modifying its behavior.'
    ],
    expected_behavior: 'answer_found',  // Should answer, not say "I couldn't find"
  },
  {
    name: 'refuses when content is irrelevant',
    question: 'What is the capital of France?',
    retrieved_chunks: [
      'Python decorators modify function behavior at runtime.'
    ],
    expected_behavior: 'not_found',  // Should say "I couldn't find" — NOT guess
  },
  {
    name: 'refuses with empty chunks',
    question: 'Explain quantum physics',
    retrieved_chunks: [],
    expected_behavior: 'not_found',
  },
  {
    name: 'answers in requested language',
    question: '什么是装饰器?',
    retrieved_chunks: ['A decorator wraps a function.'],
    preferred_language: 'zh',
    expected_behavior: 'language_match',
    expected_language: 'zh',
  },
  {
    name: 'includes citations',
    question: 'What is a decorator?',
    retrieved_chunks: [{
      text: 'A decorator wraps a function.',
      metadata: { lesson_title: 'Advanced Python', section_heading: 'Decorators' }
    }],
    expected_behavior: 'has_citations',
    expected_min_citations: 1,
  },
];

describe('Tutor Groundedness', () => {
  for (const test of GROUNDEDNESS_TESTS) {
    it(test.name, async () => {
      const result = await callTutor({
        question: test.question,
        retrieved_chunks: test.retrieved_chunks,
        preferred_language: test.preferred_language || 'en',
      });

      switch (test.expected_behavior) {
        case 'answer_found':
          expect(result.answer).not.toContain("I couldn't find");
          expect(result.answer.length).toBeGreaterThan(50);
          break;
        case 'not_found':
          expect(result.answer).toMatch(/couldn't find|could not find|not covered/i);
          expect(result.scope_expansion_suggested).toBe(true);
          break;
        case 'language_match':
          const detectedLang = await detectLanguage(result.answer); // use small model
          expect(detectedLang).toBe(test.expected_language);
          break;
        case 'has_citations':
          expect(result.citations.length).toBeGreaterThanOrEqual(test.expected_min_citations);
          expect(result.citations[0]).toHaveProperty('lesson_title');
          expect(result.citations[0]).toHaveProperty('section_heading');
          break;
      }
    });
  }
});
```

### Online Eval: LLM-as-Judge (Sampled)

Sample 5% of production Tutor calls. Ask a separate model (not the one that generated) to rate.

```typescript
// lib/eval/tutor-judge.ts

const JUDGE_PROMPT = `Rate this tutor response on a scale of 1-5 for each dimension:

CONTEXT (retrieved chunks):
{{chunks}}

QUESTION:
{{question}}

TUTOR ANSWER:
{{answer}}

Rate:
1. GROUNDEDNESS (1-5): Is the answer based ONLY on the provided context? 
   Penalize if the model adds knowledge not in the context.
2. HELPFULNESS (1-5): Does the answer directly address the question?
3. LANGUAGE_QUALITY (1-5): Is the language fluent, natural, and in the correct language?
4. CITATION_ACCURACY (1-5): Do the citations correctly reference the source content?

Return JSON: {"groundedness": N, "helpfulness": N, "language_quality": N, "citation_accuracy": N}`;

export async function evaluateTutorResponse(
  chunks: string[],
  question: string,
  answer: string,
  env: Env
): Promise<TutorEvalScores> {
  const prompt = JUDGE_PROMPT
    .replace('{{chunks}}', chunks.join('\n---\n'))
    .replace('{{question}}', question)
    .replace('{{answer}}', answer);

  // Use a SMALL model for judging (cheaper, faster)
  const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 200,
  });

  const scores = JSON.parse(result.response);

  // Emit to Analytics Engine
  env.ANALYTICS.writeDataPoint({
    blobs: ['tutor', 'quality'],
    doubles: [scores.groundedness, scores.helpfulness, scores.language_quality, scores.citation_accuracy],
  });

  return scores;
}
```

### Tutor Quality Gates (CI)

```
All must pass to deploy:
  ✅ Groundedness: ≥95% of test cases pass (15/15 mandatory cases)
  ✅ Not-found refusal: 100% (never hallucinates when no chunks)
  ✅ Citation presence: 100% of answered questions include ≥1 citation
  ✅ Language match: ≥90% of non-English questions answered in correct language
```

---

## AI06 — Learning Paths Evaluation

### Offline Eval: Ordering Correctness

The path generator produces an ordered list. We validate algorithmically.

```typescript
const PATH_TESTS = [
  {
    name: 'respects prerequisites',
    learner: { skills: ['Python basics'], goal: 'data engineer', experience: 'Beginner' },
    catalogue: [
      { id: 'python-basics', difficulty: 'Beginner', prerequisites: [] },
      { id: 'python-intermediate', difficulty: 'Intermediate', prerequisites: ['python-basics'] },
      { id: 'data-pipelines', difficulty: 'Intermediate', prerequisites: ['python-intermediate', 'sql-fundamentals'] },
      { id: 'sql-fundamentals', difficulty: 'Beginner', prerequisites: [] },
    ],
    validations: [
      { type: 'prerequisite_order', description: 'python-basics before python-intermediate' },
      { type: 'prerequisite_order', description: 'python-intermediate before data-pipelines' },
      { type: 'no_duplicates', description: 'no duplicate courses' },
    ]
  },
  {
    name: 'detects circular prerequisites',
    catalogue: [
      { id: 'a', prerequisites: ['b'] },
      { id: 'b', prerequisites: ['a'] },  // Circular!
    ],
    expected: 'error',  // Should detect and reject
  },
  {
    name: 'minimal profile returns catalogue',
    learner: { skills: [], goals: '', experience: 'Beginner' },
    catalogue: [/* 5 courses */],
    expected_tier: 'minimal',
    expected_behavior: 'no_generated_path',  // Just return catalogue, no LLM call
  },
  {
    name: 'difficulty increases monotonically (mostly)',
    catalogue: [/* courses at various difficulties */],
    validations: [
      { type: 'difficulty_inversions', max: 1 },  // Allow at most 1 difficulty drop
    ]
  },
];

describe('Path Ordering', () => {
  for (const test of PATH_TESTS) {
    it(test.name, async () => {
      const path = await generatePath(test.learner, test.catalogue);

      if (test.expected === 'error') {
        expect(path).toBe(null); // or expect to throw
        return;
      }

      for (const v of test.validations) {
        switch (v.type) {
          case 'prerequisite_order': {
            // Topological sort validation
            const violations = validatePrerequisites(path.courses, prerequisitesMap(test.catalogue));
            expect(violations).toHaveLength(0);
            break;
          }
          case 'no_duplicates': {
            const ids = path.courses.map(c => c.course_id);
            expect(new Set(ids).size).toBe(ids.length);
            break;
          }
          case 'difficulty_inversions': {
            const inversions = countDifficultyInversions(path.courses);
            expect(inversions).toBeLessThanOrEqual(v.max);
            break;
          }
        }
      }
    });
  }
});
```

### Online Eval: LLM-as-Judge (Sampled)

```typescript
const PATH_JUDGE_PROMPT = `Rate this learning path on 1-5:

LEARNER: {skills: {{skills}}, goal: "{{goal}}", experience: "{{experience}}"}
PATH: {{path}}

1. LOGICAL_FLOW: Do skills build on each other? Are prerequisites respected?
2. GOAL_ALIGNMENT: Does this path lead to the stated goal?
3. DIFFICULTY_CURVE: Does difficulty increase appropriately?

Return JSON: {"logical_flow": N, "goal_alignment": N, "difficulty_curve": N}`;
```

### Path Quality Gates

```
  ✅ Prerequisite compliance: 100% (algorithmic — cannot fail)
  ✅ Skill coverage: ≥60% of goal-relevant skills covered
  ✅ LLM-as-judge avg score: ≥3.5/5 across all three dimensions
  ✅ Minimal profile: returns catalogue, never calls LLM
```

---

## AI07 — Recommendations Evaluation

### Offline Eval: Fallback Cascade

```typescript
const REC_TESTS = [
  {
    name: 'AI available → returns AI recs',
    ai_available: true,
    org_defaults: ['course-1', 'course-2'],
    expected: { source: 'ai', min_courses: 1 },
  },
  {
    name: 'AI down → org defaults',
    ai_available: false,
    org_defaults: ['course-1', 'course-2'],
    expected: { source: 'fallback', tier: 'org_defaults', courses: ['course-1', 'course-2'] },
  },
  {
    name: 'No org defaults → popular in org',
    ai_available: false,
    org_defaults: [],
    popular_in_org: ['course-3'],
    expected: { source: 'fallback', tier: 'popular_in_org' },
  },
  {
    name: 'Nothing configured → platform-wide popular',
    ai_available: false,
    org_defaults: [],
    popular_in_org: [],
    expected: { source: 'fallback', tier: 'platform_wide', min_courses: 1 },
  },
  {
    name: 'widget never returns empty',
    ai_available: false,
    org_defaults: [],
    popular_in_org: [],
    platform_wide: ['course-99'],
    expected: { min_courses: 1 },
  },
];

describe('Recommendations Fallback', () => {
  for (const test of REC_TESTS) {
    it(test.name, async () => {
      const result = await getRecommendations({
        ai_available: test.ai_available,
        org_defaults: test.org_defaults,
        popular_in_org: test.popular_in_org || [],
        platform_wide: test.platform_wide || ['course-99'],
      });

      expect(result.source).toBe(test.expected.source);
      if (test.expected.tier) expect(result.tier).toBe(test.expected.tier);
      if (test.expected.courses) expect(result.courses.map(c => c.id)).toEqual(test.expected.courses);
      if (test.expected.min_courses) expect(result.courses.length).toBeGreaterThanOrEqual(test.expected.min_courses);
    });
  }
});
```

### Recs Quality Gates

```
  ✅ Never returns empty: 100% (at minimum, platform-wide popular)
  ✅ Fallback cascade: all 4 tiers tested
  ✅ Cache hit rate: >0% (cache is working)
  ✅ AI source label correct: 'ai' vs 'fallback' flag present in every response
```

---

## AI08 — Post-Quiz Insights Evaluation

### Offline Eval: Tone Enforcement

```typescript
const TONE_TESTS = [
  { score: 95, expected_tone: 'positive', forbidden: ['fail', 'bad', 'poor', 'disappointing'] },
  { score: 80, expected_tone: 'positive', forbidden: ['fail', 'bad', 'poor'] },
  { score: 79, expected_tone: 'coaching', forbidden: ['fail', 'bad', 'shame', 'disappointing'] },
  { score: 50, expected_tone: 'coaching', forbidden: ['fail', 'bad', 'shame', 'stupid'] },
  { score: 0,  expected_tone: 'coaching', forbidden: ['fail', 'bad', 'shame', 'stupid', 'hopeless'] },
];

describe('Insights Tone', () => {
  for (const test of TONE_TESTS) {
    it(`score ${test.score} → ${test.expected_tone} tone`, async () => {
      const result = await generateInsight({ score_pct: test.score, /* ... */ });

      // Check forbidden words
      for (const word of test.forbidden) {
        expect(result.insight.toLowerCase()).not.toContain(word);
      }

      // Check tone markers
      if (test.expected_tone === 'positive') {
        expect(result.insight).toMatch(/great|excellent|well done|strong|mastered/i);
      } else {
        expect(result.insight).toMatch(/review|practice|try|improve|focus on/i);
      }

      // Must include review links for low scores
      if (test.score < 80) {
        expect(result.review_links.length).toBeGreaterThan(0);
      }
    });
  }
});
```

### Insights Quality Gates

```
  ✅ No negative/shaming language: 100% (regex check on all outputs)
  ✅ >80% score → positive reinforcement: 100%
  ✅ <80% score → review links present: 100%
  ✅ All incorrect questions reference a valid lesson section: 100%
```

---

## AI09 — Platform Assistant Evaluation

### Offline Eval: Intent Classification

```typescript
const INTENT_TESTS = [
  { question: 'How far am I in this course?', expected_intent: 'progress' },
  { question: 'What should I do next?', expected_intent: 'progress' },
  { question: 'How many lessons left?', expected_intent: 'progress' },
  { question: 'Explain Python decorators', expected_intent: 'content' },
  { question: 'What is a variable?', expected_intent: 'content' },
  { question: 'Tell me about functions', expected_intent: 'content' },
  // Edge cases
  { question: 'How do I learn Python?', expected_intent: 'content' }, // Could be either — content wins for safety
  { question: 'hello', expected_intent: 'unknown' },
  { question: 'asdfghjkl', expected_intent: 'unknown' },
];

describe('Assistant Intent Classification', () => {
  for (const test of INTENT_TESTS) {
    it(`"${test.question}" → ${test.expected_intent}`, () => {
      const intent = classifyIntent(test.question);
      expect(intent).toBe(test.expected_intent);
    });
  }
});
```

### Assistant Quality Gates

```
  ✅ Intent accuracy: ≥90% on known query set (tested with 50+ queries)
  ✅ Content questions in lesson → handoff link present: 100%
  ✅ Content questions outside lesson → suggests Tutor navigation: 100%
  ✅ Progress queries → returns actual progress data (not hallucinated): 100%
  ✅ Unknown intent → helpful fallback message: 100%
```

---

## AI10a — Question Generation Evaluation

### Offline Eval: Source Grounding + Format

```typescript
const GEN_TESTS = [
  {
    name: 'generates correct number of questions',
    lesson_id: 'python-functions',
    num_questions: 5,
    expected_count: 5,  // ±1 tolerance for LLM non-determinism
    tolerance: 1,
  },
  {
    name: 'each question has source trace',
    lesson_id: 'python-functions',
    num_questions: 3,
    required_fields: ['source_chunk_id', 'source_excerpt', 'lesson_title', 'section_heading'],
  },
  {
    name: 'multiple choice has exactly 4 options',
    lesson_id: 'python-functions',
    num_questions: 3,
    validation: (questions) => {
      for (const q of questions) {
        if (q.question_type === 'multiple_choice') {
          expect(q.options).toHaveLength(4);
          expect(q.options.filter(o => o.correct).length).toBe(1);
        }
      }
    },
  },
  {
    name: 'questions are grounded in source material',
    lesson_id: 'python-functions',
    num_questions: 2,
    validation: (questions, source_chunks) => {
      for (const q of questions) {
        // Question should semantically relate to at least one source chunk
        const relevance = checkSemanticRelevance(q.question_text, source_chunks);
        expect(relevance).toBeGreaterThan(0.5);
      }
    },
  },
  {
    name: 'rejects unreasonable counts',
    num_questions: 50,
    expected_status: 422,  // Too many
  },
  {
    name: 'rejects zero questions',
    num_questions: 0,
    expected_status: 422,
  },
];
```

### Gen Quality Gates

```
  ✅ Question count: ±10% of requested (LLM non-determinism)
  ✅ Source traceability: 100% of questions link to a chunk
  ✅ Format compliance: MC has 4 options, TF has boolean answer, short answer has text
  ✅ Sanity limits: >20 → 422, 0 → 422
  ✅ Groundedness: ≥80% of questions semantically relate to source material
```

---

## AI11 — Quality Checks Evaluation

### Offline Eval: Duplicate Detection

```typescript
const DUPLICATE_TESTS = [
  {
    name: 'detects near-identical questions',
    questions: [
      'What is a Python decorator?',
      'Explain Python decorators.',
      'What is the capital of France?',
    ],
    expected_duplicates: [[0, 1]],  // Questions 0 and 1 are duplicates
  },
  {
    name: 'no false positives on distinct questions',
    questions: [
      'What is a Python decorator?',
      'What is a variable in Python?',
      'How do you write a for loop?',
    ],
    expected_duplicates: [],
  },
  {
    name: 'threshold is configurable',
    questions: [
      'What is a function?',
      'How do functions work?',
    ],
    threshold: 0.70,  // Lower threshold → more sensitive
    expected_duplicates: [[0, 1]],
  },
];

describe('Duplicate Detection', () => {
  for (const test of DUPLICATE_TESTS) {
    it(test.name, async () => {
      // Embed all questions via bge-m3
      const embeddings = await Promise.all(
        test.questions.map(q => embed(q, env))
      );

      // Compute pairwise cosine similarity
      const duplicates = findDuplicates(embeddings, test.threshold || 0.85);

      expect(duplicates).toEqual(test.expected_duplicates);
    });
  }
});
```

### Quality Checks Gates

```
  ✅ Duplicate recall: ≥90% (catches genuine duplicates)
  ✅ Duplicate precision: ≥95% (doesn't flag non-duplicates)
  ✅ Reading level: correctly identifies questions above/below course difficulty
  ✅ can_publish flag: true ONLY when zero issues
```

---

## Evaluation Pipeline on Cloudflare

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CI/CD Pipeline (GitHub Actions / wrangler deploy)      │
│                                                          │
│  1. Run unit tests (vitest)                              │
│  2. Run eval suite against test fixtures                 │
│  3. Check quality gates                                  │
│  4. Deploy if all gates pass                             │
│                                                          │
│  Eval Worker (runs in CI with wrangler dev)             │
│    ├── Tutor groundedness tests (15 cases)               │
│    ├── Path ordering tests (10 cases)                    │
│    ├── Recs fallback tests (5 cases)                     │
│    ├── Insights tone tests (5 cases)                     │
│    ├── Assistant intent tests (12 cases)                 │
│    └── Question gen tests (6 cases)                      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Production Sampling (Cron Worker, runs every hour)      │
│                                                          │
│  1. Sample 5% of Tutor calls from last hour              │
│  2. Run LLM-as-Judge on sampled calls                    │
│  3. Emit scores to Analytics Engine                      │
│  4. Alert if avg score drops below threshold             │
└─────────────────────────────────────────────────────────┘
```

### CI Eval Runner

```typescript
// eval/ci-runner.ts — runs in CI before deploy

interface EvalResult {
  feature: string;
  metric: string;
  passed: number;
  total: number;
  threshold: number;
}

export async function runCIEvaluation(env: Env): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  // Tutor
  const tutorGroundedness = await runTutorGroundednessTests(env);
  results.push({
    feature: 'tutor',
    metric: 'groundedness',
    passed: tutorGroundedness.passed,
    total: tutorGroundedness.total,
    threshold: 0.95,
  });

  // Learning Paths
  const pathPrereqs = await runPathPrerequisiteTests(env);
  results.push({
    feature: 'paths',
    metric: 'prerequisite_compliance',
    passed: pathPrereqs.passed,
    total: pathPrereqs.total,
    threshold: 1.0,  // 100% — algorithmic, cannot fail
  });

  // ... repeat for all features

  // Check gates
  const failures = results.filter(r => r.passed / r.total < r.threshold);
  if (failures.length > 0) {
    console.error('QUALITY GATES FAILED:', JSON.stringify(failures));
    throw new Error(`CI blocked: ${failures.length} quality gates failed`);
  }

  console.log('All quality gates passed:', JSON.stringify(results));
  return results;
}
```

---

## Summary: Quality Gates Per Feature

| Feature | Gate | Threshold | Method |
|---|---|---|---|
| **Tutor** | Groundedness | ≥95% | Offline test cases |
| **Tutor** | Not-found refusal | 100% | Offline test cases |
| **Tutor** | Citation presence | 100% | Offline test cases |
| **Tutor** | Language match | ≥90% | Offline test cases |
| **Tutor** | LLM-as-Judge quality | ≥3.5/5 | Online sampling |
| **Paths** | Prerequisite compliance | 100% | Algorithmic |
| **Paths** | Skill coverage | ≥60% | Offline computation |
| **Paths** | LLM-as-Judge quality | ≥3.5/5 | Online sampling |
| **Recs** | Never empty | 100% | Offline test cases |
| **Recs** | Fallback cascade | 4/4 tiers | Offline test cases |
| **Insights** | No negative language | 100% | Regex check |
| **Insights** | Review links for <80% | 100% | Offline test cases |
| **Assistant** | Intent accuracy | ≥90% | Offline test cases |
| **Assistant** | Handoff present | 100% | Offline test cases |
| **Gen** | Source traceability | 100% | Offline verification |
| **Gen** | Format compliance | ≥95% | Offline test cases |
| **Quality** | Duplicate recall | ≥90% | Offline test cases |
| **Quality** | Duplicate precision | ≥95% | Offline test cases |

---

## Cost of Evaluation

| Eval Type | Model Used | Cost per Eval | Frequency |
|---|---|---|---|
| Offline groundedness | Llama 3.2 (generates answer) | ~500 tokens × 15 cases = 7,500 tokens | Every CI run |
| Offline format checks | None (regex/algorithmic) | $0 | Every CI run |
| Online LLM-as-Judge | Llama 3.2 (small model) | ~300 tokens per judgment | 5% of production calls |
| Embedding similarity | bge-m3 | ~50ms per comparison | All duplicate checks |

At 10,000 Tutor calls/day with 5% sampling: ~500 judgments × 300 tokens = 150K tokens/day for eval. On Cloudflare free tier, that's within limits.

---

## Adding a New Feature

When you add a new AI feature, the eval checklist:

1. [ ] **5-15 offline test cases** covering happy path, edge cases, and failure modes
2. [ ] **At least 1 algorithmic check** that doesn't need an LLM (regex, ordering, format)
3. [ ] **LLM-as-Judge prompt** for subjective quality (optional for MVP, add in Phase 2)
4. [ ] **Quality gate threshold** — what's the minimum pass rate to allow deploy?
5. [ ] **CI integration** — wired into the pre-deploy evaluation runner
