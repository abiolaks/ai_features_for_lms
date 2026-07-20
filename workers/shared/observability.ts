// ============================================================
// Shared Observability Helpers
// ============================================================
// Workers built-in observability captures top-level request spans.
// These helpers add structured console.log for custom sub-spans,
// surfaced via wrangler tail / Workers Logs / Analytics Engine.
// ============================================================

export interface SpanContext {
  name: string;
  attrs: Record<string, unknown>;
  startMs: number;
}

/** Start a new span. Call setAttr to add metadata, then endSpan when done. */
export function startSpan(name: string): SpanContext {
  return { name, attrs: {}, startMs: Date.now() };
}

/** Set an attribute on a span. */
export function setAttr(ctx: SpanContext, key: string, value: unknown): void {
  ctx.attrs[key] = value;
}

/** End the span and emit it as structured JSON to console.log. */
export function endSpan(ctx: SpanContext): void {
  const duration = Date.now() - ctx.startMs;
  console.log(
    JSON.stringify({
      span: ctx.name,
      duration_ms: duration,
      ...ctx.attrs,
    })
  );
}
