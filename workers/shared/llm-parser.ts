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
 *
 * Returns the parsed object cast to T, or null if no valid JSON found.
 */
export function parseLlmJson<T>(response: string): T | null {
  // Try markdown code block first (most common LLM output pattern)
  const codeBlock = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlock ? codeBlock[1] : response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonStr) return null;

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return null;
  }
}
