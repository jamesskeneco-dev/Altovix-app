import { config } from "../config.ts";
import { validate } from "./schema.ts";
import { type LlmClient, type LlmRequest, type LlmResponse, LlmError } from "./types.ts";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_ATTEMPTS = 4;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}
interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Structured output is obtained by forcing a single tool call whose input_schema
 * is the agent's schema. That gives schema-shaped JSON from the model itself
 * instead of parsing prose, and anything still malformed is retried with the
 * validation errors fed back rather than silently coerced.
 */
export function anthropicClient(apiKey = config.apiKey): LlmClient {
  return {
    mode: "real",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      if (!apiKey) throw new LlmError("ANTHROPIC_API_KEY is not set", 0);
      const model = req.model ?? config.model;
      const started = Date.now();
      let lastDetail = "";
      let correction = "";

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let res: Response;
        try {
          res = await fetch(API_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": API_VERSION,
            },
            body: JSON.stringify({
              model,
              max_tokens: req.maxTokens ?? 2000,
              temperature: req.temperature ?? 0.2,
              system: req.system,
              tools: [{ name: req.toolName, description: req.toolDescription, input_schema: req.schema }],
              tool_choice: { type: "tool", name: req.toolName },
              messages: [{ role: "user", content: correction ? `${req.user}\n\n${correction}` : req.user }],
            }),
          });
        } catch (err) {
          lastDetail = `network: ${(err as Error).message}`;
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }

        if (res.status === 429 || res.status >= 500) {
          lastDetail = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
          const retryAfter = Number(res.headers.get("retry-after") ?? 0);
          await sleep(retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** (attempt - 1));
          continue;
        }
        if (!res.ok) {
          throw new LlmError(`Anthropic API ${res.status}`, attempt, (await res.text()).slice(0, 500));
        }

        const payload = (await res.json()) as AnthropicResponse;
        const toolBlock = payload.content?.find((b) => b.type === "tool_use" && b.name === req.toolName);
        if (!toolBlock || toolBlock.input === undefined) {
          lastDetail = `no tool_use block; got ${JSON.stringify(payload.content ?? payload.error).slice(0, 300)}`;
          correction = "Your previous reply did not call the required tool. Call it exactly once with the full result.";
          continue;
        }

        const errors = validate(toolBlock.input, req.schema);
        if (errors.length) {
          lastDetail = `schema: ${errors.join("; ")}`;
          correction =
            `Your previous tool call failed validation:\n${errors.map((e) => `- ${e}`).join("\n")}\n` +
            `Call the tool again with every field corrected.`;
          continue;
        }

        return {
          json: toolBlock.input,
          raw: JSON.stringify(toolBlock.input),
          model,
          inputTokens: payload.usage?.input_tokens ?? 0,
          outputTokens: payload.usage?.output_tokens ?? 0,
          latencyMs: Date.now() - started,
          attempts: attempt,
        };
      }
      throw new LlmError(`failed after ${MAX_ATTEMPTS} attempts`, MAX_ATTEMPTS, lastDetail);
    },
  };
}
