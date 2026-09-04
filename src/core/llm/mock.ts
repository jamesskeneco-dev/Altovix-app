import type { JsonSchema } from "./schema.ts";
import type { LlmClient, LlmRequest, LlmResponse } from "./types.ts";

/** FNV-1a - deterministic seed from the request so dry runs are reproducible. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function synth(schema: JsonSchema, next: () => number, key: string, tool: string): unknown {
  if (schema.enum && schema.enum.length) {
    return schema.enum[Math.floor(next() * schema.enum.length) % schema.enum.length];
  }
  switch (schema.type) {
    case "boolean":
      return next() > 0.5;
    case "integer": {
      const lo = schema.minimum ?? 1;
      const hi = schema.maximum ?? lo + 60;
      return Math.round(lo + next() * (hi - lo));
    }
    case "number": {
      const lo = schema.minimum ?? -1;
      const hi = schema.maximum ?? 1;
      return Math.round((lo + next() * (hi - lo)) * 1000) / 1000;
    }
    case "array": {
      const n = Math.max(schema.minItems ?? 1, 1);
      return Array.from({ length: n }, () =>
        synth(schema.items ?? { type: "string" }, next, key, tool));
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        out[k] = synth(sub, next, k, tool);
      }
      return out;
    }
    default: {
      let text = `[mock:${tool}] ${key}: ${schema.description ?? "placeholder"}`;
      const min = schema.minLength ?? 0;
      // Pad to any stated minimum so mock output is genuinely schema-valid, not merely close.
      while (text.length < min) {
        text += ` This is deterministic filler produced offline for ${key}; it carries no analytical meaning.`;
      }
      return text.slice(0, Math.max(min, 400));
    }
  }
}

/**
 * Offline stand-in for the real model. Produces deterministic, schema-valid output
 * so the full committee chain, the persistence layer and the calibration resolver
 * can be exercised end to end without an API key or a cent of spend.
 *
 * Its answers are meaningless by construction - it exists to test plumbing, never
 * to produce a decision anyone acts on. Runs made in this mode are tagged
 * llm_mode='mock' in committee_runs and are excluded from calibration scoring.
 */
export function mockClient(): LlmClient {
  return {
    mode: "mock",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const next = rng(hash(req.toolName + req.user));
      const json = synth(req.schema, next, "root", req.toolName);
      return {
        json,
        raw: JSON.stringify(json),
        model: "mock",
        inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
        outputTokens: Math.ceil(JSON.stringify(json).length / 4),
        latencyMs: 0,
        attempts: 1,
      };
    },
  };
}
