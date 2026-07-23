import { describe, it, expect } from 'vitest';
import { parseLlmJson } from '../../shared/llm-parser';

// ──── Fixtures ────

interface GapResponse {
  gaps: { skill: string; current_level: string; required_level: string; courses_available: number; estimated_hours: number }[];
  summary: string;
}

const GAP_RESPONSE: GapResponse = {
  gaps: [
    { skill: 'spark', current_level: 'none', required_level: 'intermediate', courses_available: 3, estimated_hours: 40 },
    { skill: 'data-modeling', current_level: 'none', required_level: 'intermediate', courses_available: 2, estimated_hours: 20 },
  ],
  summary: 'Strong foundation in Python and SQL. Biggest opportunity is distributed computing with Spark — 3 courses available.',
};

// ════════════════════════════════════════════════════════
//  Tests
// ════════════════════════════════════════════════════════

describe('parseLlmJson', () => {
  // ──── Happy path: markdown code blocks ────

  it('parses JSON inside ```json code block', () => {
    const response = '```json\n' + JSON.stringify(GAP_RESPONSE) + '\n```';
    const result = parseLlmJson<GapResponse>(response);
    expect(result).not.toBeNull();
    expect(result!.gaps).toHaveLength(2);
    expect(result!.gaps[0].skill).toBe('spark');
  });

  it('parses JSON inside ``` code block (no language tag)', () => {
    const response = '```\n' + JSON.stringify(GAP_RESPONSE) + '\n```';
    const result = parseLlmJson<GapResponse>(response);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain('Strong foundation');
  });

  it('parses JSON inside code block with text before and after', () => {
    const response = 'Here is your analysis:\n```json\n' + JSON.stringify(GAP_RESPONSE) + '\n```\nLet me know if you need more!';
    const result = parseLlmJson<GapResponse>(response);
    expect(result).not.toBeNull();
  });

  // ──── Happy path: bare JSON ────

  it('parses bare JSON object', () => {
    const response = JSON.stringify(GAP_RESPONSE);
    const result = parseLlmJson<GapResponse>(response);
    expect(result).not.toBeNull();
    expect(result!.gaps).toHaveLength(2);
  });

  it('parses JSON with surrounding non-code-block text', () => {
    const response = 'I found these gaps: ' + JSON.stringify(GAP_RESPONSE) + ' Would you like me to elaborate?';
    const result = parseLlmJson<GapResponse>(response);
    expect(result).not.toBeNull();
  });

  // ──── Edge cases ────

  it('returns null for empty string', () => {
    const result = parseLlmJson('');
    expect(result).toBeNull();
  });

  it('returns null for plain text with no JSON', () => {
    const result = parseLlmJson('I could not generate any gaps. Please try again.');
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON in code block', () => {
    const response = '```json\n{gaps: [broken json}\n```';
    const result = parseLlmJson(response);
    expect(result).toBeNull();
  });

  it('returns null for truncated response (no closing brace)', () => {
    const response = '{"gaps": [{"skill": "spark", "current';
    const result = parseLlmJson(response);
    expect(result).toBeNull();
  });

  it('parses empty object {}', () => {
    const result = parseLlmJson<{ gaps: never[]; summary: string }>('{}');
    expect(result).not.toBeNull();
  });

  it('handles nested JSON with nested braces', () => {
    const nested = { id: 'x', meta: { depth: 1, inner: { val: 'deep' } } };
    const response = '```json\n' + JSON.stringify(nested) + '\n```';
    const result = parseLlmJson<typeof nested>(response);
    expect(result).not.toBeNull();
    expect(result!.meta.inner.val).toBe('deep');
  });

  // ──── Code block edge cases ────

  it('prefers code block over bare JSON when both present', () => {
    // LLM sometimes adds explanatory JSON in text then the real one in code block
    const preambleJson = JSON.stringify({ wrong: true });
    const correctJson = JSON.stringify({ correct: true });
    const response = `Here's one approach: ${preambleJson}\n\n\`\`\`json\n${correctJson}\n\`\`\``;
    const result = parseLlmJson<{ correct: boolean }>(response);
    expect(result).not.toBeNull();
    expect(result!.correct).toBe(true);
  });
});
