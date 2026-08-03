// ============================================================
// Shared String Sanitizer
// ============================================================
// Strips quotes, trims whitespace, and caps length. Used by
// multiple workers to clean LLM-generated string fields before
// including them in API responses.
// ============================================================

/**
 * Sanitize an LLM-generated string.
 *
 * - Strips leading/trailing quotes (common LLM artifact)
 * - Trims whitespace
 * - Caps at maxLength (default 500 chars)
 * - Returns empty string for null/undefined input
 *
 * @param text       Raw string from LLM output (may be undefined)
 * @param maxLength  Maximum allowed length (default 500)
 */
export function sanitize(text: string | undefined, maxLength: number = 500): string {
  if (!text) return '';
  return text.replace(/^["']+|["']+$/g, '').trim().slice(0, maxLength);
}
