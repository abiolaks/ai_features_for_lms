// ============================================================
// Shared LLM JSON Response Parser
// ============================================================
// LLMs often wrap JSON in markdown code blocks or return bare
// JSON. This extracts the JSON substring from a raw response,
// attempts JSON.parse, and returns the typed result or null.
// ============================================================

/**
 * Extract and parse JSON from an LLM response string.
 *
 * Handles:
 *  - Markdown code blocks: ` ```json\n{...}\n``` `
 *  - Bare JSON objects: `{...}`
 *  - Leading/trailing text around the JSON
 *  - Truncated/incomplete JSON (LLM stopped mid-generation)
 *
 * Returns the parsed object cast to T, or null if no valid JSON found.
 */
export function parseLlmJson<T>(response: string): T | null {
  // Try markdown code block first (most common LLM output pattern)
  const codeBlock = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const inner = codeBlock ? codeBlock[1] : response;

  // Try object first (most common), then array
  const strictObj = inner.match(/\{[\s\S]*\}/)?.[0];
  const strictArr = inner.match(/\[[\s\S]*\]/)?.[0];
  const strictJson = strictObj || strictArr;
  if (strictJson) {
    try {
      return JSON.parse(strictJson) as T;
    } catch { /* fall through to recovery */ }
  }

  // ── Recovery: LLM truncated JSON (missing closing braces/brackets) ──
  // Find the first `{` or `[`, then balance braces.
  const firstObj = inner.indexOf('{');
  const firstArr = inner.indexOf('[');
  let firstIdx = -1;
  if (firstObj === -1 && firstArr === -1) return null;
  if (firstObj === -1) firstIdx = firstArr;
  else if (firstArr === -1) firstIdx = firstObj;
  else firstIdx = Math.min(firstObj, firstArr);

  let candidate = inner.slice(firstIdx);
  const balanced = balanceBraces(candidate);
  if (!balanced) return null;
  candidate = balanced;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

/**
 * Add closing braces/brackets to balance an incomplete JSON string.
 * Returns the balanced string, or null if balancing fails.
 */
function balanceBraces(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
    } else if (ch === '}' || ch === ']') {
      if (stack.length === 0) return null; // unexpected closing
      const expected = stack.pop()!;
      if (ch !== expected) return null; // mismatch
    }
  }

  // Add missing closing brackets in reverse order
  const closing = stack.reverse().join('');
  return text + closing;
}
