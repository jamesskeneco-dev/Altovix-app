import { config } from "../config.ts";
import { anthropicClient } from "./anthropic.ts";
import { mockClient } from "./mock.ts";
import type { LlmClient } from "./types.ts";

export * from "./types.ts";
export * from "./schema.ts";
export { anthropicClient, mockClient };

export function makeClient(mode: "real" | "mock" = config.llmMode): LlmClient {
  if (mode === "mock") return mockClient();
  if (!config.apiKey) {
    throw new Error(
      "ALTOVIX_LLM=real but ANTHROPIC_API_KEY is empty. Set the key, or run with ALTOVIX_LLM=mock for an offline dry run.",
    );
  }
  return anthropicClient();
}
