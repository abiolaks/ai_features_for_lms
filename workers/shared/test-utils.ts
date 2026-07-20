// ============================================================
// Shared Test Utilities
// ============================================================
// Mock factories and span tracking helpers used across
// multiple worker test suites. Avoids copy-paste drift.
// ============================================================

import { vi } from "vitest";

/**
 * Create a mock Fetcher that returns a JSON response.
 * Matches the Cloudflare service binding shape (object with .fetch()).
 *
 *   (env as any).AI_GATEWAY = createMockGateway({ response: "hi" });
 */
export function createMockGateway(
  response: object | null,
  ok = true,
): { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  };
}

/**
 * Create an AI03 Gateway response body with standard fields.
 * Workers parse this to get text, model_used, tokens_used.
 *
 *   createLlmResponse([{ course_title: "Python", score: 85 }])
 */
export function createLlmResponse(payload: unknown): object {
  return {
    response: JSON.stringify(payload),
    model_used: "@cf/meta/llama-3.2-3b-instruct",
    provider: "cloudflare",
    tokens_used: 100,
    throttle_warning: false,
  };
}

/**
 * Spy on console.log to capture structured span JSON.
 * Returns the logs array and a helper to filter by span name.
 *
 *   const { logs, spans } = spyOnSpans();
 *   // ... run test ...
 *   expect(spans("lms.fetch")).toHaveLength(1);
 */
export function spyOnSpans(): {
  logs: string[];
  spans: (name: string) => Record<string, unknown>[];
} {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(String(args[0]));
  });
  return {
    logs,
    spans: (name: string) =>
      logs
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((s) => s && s.span === name) as Record<string, unknown>[],
  };
}
