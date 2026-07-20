// ============================================================
// Shared AI Gateway Client
// ============================================================
// All AI workers call AI03 Gateway via service binding. This
// shared function encapsulates the fetch → parse → normalize
// pattern. Workers call this instead of constructing the
// Request manually.
// ============================================================

export interface GatewayResult {
  text: string;
  model: string;
  tokens: number;
}

/**
 * Call AI03 Gateway via service binding.
 * Returns parsed result or null if the gateway is unreachable.
 * Workers wrap this in their own span tracking and error handling.
 */
export async function callGateway(
  gateway: Fetcher,
  prompt: string,
  orgId: string,
): Promise<GatewayResult | null> {
  try {
    const resp = await gateway.fetch(
      new Request("https://ai-gateway/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          tier: "standard",
          org_id: orgId,
        }),
      }),
    );

    if (!resp.ok) return null;

    const llm = (await resp.json()) as any;
    const raw: unknown = llm.response;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);

    return {
      text,
      model: llm.model_used || "unknown",
      tokens: llm.tokens_used || 0,
    };
  } catch {
    return null;
  }
}
