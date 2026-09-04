/**
 * Tiny JSON-Schema subset validator.
 *
 * Enough to constrain every agent's output and reject malformed model responses
 * before they reach the audit trail. Supports: type, properties, required,
 * additionalProperties:false, items, enum, minimum/maximum, minItems/maxItems.
 */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
}

export function validate(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  const t = schema.type;

  if (t) {
    const actual =
      value === null ? "null"
      : Array.isArray(value) ? "array"
      : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number")
      : typeof value;
    const ok =
      t === actual ||
      (t === "number" && actual === "integer") ||
      (t === "integer" && actual === "integer");
    if (!ok) {
      errors.push(`${path}: expected ${t}, got ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value as string)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > ${schema.maximum}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: string shorter than ${schema.minLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: at most ${schema.maxItems} items, got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((v, i) => errors.push(...validate(v, schema.items as JsonSchema, `${path}[${i}]`)));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required property missing`);
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) errors.push(...validate(obj[key], sub, `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) errors.push(`${path}.${key}: unexpected property`);
        }
      }
    }
  }
  return errors;
}

/** Common building blocks so every agent schema reads the same way. */
export const S = {
  str: (description: string, minLength = 1): JsonSchema => ({ type: "string", description, minLength }),
  num: (description: string, min?: number, max?: number): JsonSchema => ({
    type: "number", description, ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}),
  }),
  int: (description: string, min?: number, max?: number): JsonSchema => ({
    type: "integer", description, ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}),
  }),
  bool: (description: string): JsonSchema => ({ type: "boolean", description }),
  enum: (description: string, values: readonly string[]): JsonSchema => ({ type: "string", description, enum: values }),
  confidence: (description = "Calibrated probability this call is right, 0-1. Use the full range; 0.5 means genuinely uncertain."): JsonSchema =>
    ({ type: "number", description, minimum: 0, maximum: 1 }),
  arr: (description: string, items: JsonSchema, minItems = 1, maxItems = 12): JsonSchema =>
    ({ type: "array", description, items, minItems, maxItems }),
  obj: (properties: Record<string, JsonSchema>, required?: string[]): JsonSchema => ({
    type: "object", properties, required: required ?? Object.keys(properties), additionalProperties: false,
  }),
} as const;
