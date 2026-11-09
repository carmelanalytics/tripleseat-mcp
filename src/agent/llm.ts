/**
 * Minimal Claude API client. Uses a forced tool call so every answer comes back as validated JSON.
 */

import { agentConfig } from "./config.js";

export async function callJson<T>(opts: {
  model?: string;
  system: string;
  user: string;
  toolName: string;
  schema: Record<string, any>;
  maxTokens?: number;
}): Promise<T> {
  if (!agentConfig.anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");
  const body = {
    model: opts.model || agentConfig.model,
    max_tokens: opts.maxTokens || 2000,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    tools: [{ name: opts.toolName, description: "Return the result.", input_schema: opts.schema }],
    tool_choice: { type: "tool", name: opts.toolName },
  };

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": agentConfig.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const j: any = await r.json();
    if (r.ok) {
      const block = (j.content || []).find((c: any) => c.type === "tool_use");
      if (!block) throw new Error("Claude returned no tool result");
      return block.input as T;
    }
    lastErr = `${r.status}: ${JSON.stringify(j).slice(0, 300)}`;
    if (r.status !== 429 && r.status < 500) break;
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw new Error(`Claude API error ${lastErr}`);
}
