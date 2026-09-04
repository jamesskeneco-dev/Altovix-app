import type { JsonSchema } from "./schema.ts";

export interface LlmRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  toolName: string;
  toolDescription: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  json: unknown;
  raw: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  attempts: number;
}

export interface LlmClient {
  readonly mode: "real" | "mock";
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  readonly attempts: number;
  readonly detail: string;
  constructor(message: string, attempts: number, detail = "") {
    super(message);
    this.name = "LlmError";
    this.attempts = attempts;
    this.detail = detail;
  }
}
