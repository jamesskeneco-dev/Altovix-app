import test from "node:test";
import assert from "node:assert/strict";
import { validate, S } from "../src/core/llm/schema.ts";
import { mockClient } from "../src/core/llm/mock.ts";

const shape = S.obj({
  regime: S.enum("market regime", ["RISK_ON", "NEUTRAL", "RISK_OFF"]),
  confidence: S.confidence(),
  horizonDays: S.int("horizon", 5, 90),
  drivers: S.arr("drivers", S.str("driver"), 2, 5),
});

test("accepts a well-formed object", () => {
  assert.deepEqual(
    validate({ regime: "RISK_ON", confidence: 0.7, horizonDays: 21, drivers: ["a", "b"] }, shape),
    [],
  );
});

test("catches wrong enum, out-of-range number and short arrays", () => {
  const errs = validate({ regime: "SIDEWAYS", confidence: 1.4, horizonDays: 21, drivers: ["a"] }, shape);
  assert.equal(errs.length, 3);
  assert.ok(errs.some((e) => e.includes("regime")));
  assert.ok(errs.some((e) => e.includes("1.4 > 1")));
  assert.ok(errs.some((e) => e.includes("at least 2")));
});

test("catches missing required fields and unexpected properties", () => {
  const errs = validate({ regime: "NEUTRAL", confidence: 0.5, horizonDays: 10, drivers: ["a", "b"], extra: 1 }, shape);
  assert.ok(errs.some((e) => e.includes("unexpected property")));
  const missing = validate({ regime: "NEUTRAL" }, shape);
  assert.ok(missing.some((e) => e.includes("required property missing")));
});

test("integers are not satisfied by floats", () => {
  assert.ok(validate({ regime: "NEUTRAL", confidence: 0.5, horizonDays: 10.5, drivers: ["a", "b"] }, shape)
    .some((e) => e.includes("expected integer")));
});

test("mock client always returns schema-valid output, deterministically", async () => {
  const llm = mockClient();
  const req = {
    system: "sys", user: "analyse NVDA", schema: shape,
    toolName: "emit_regime", toolDescription: "d",
  };
  const a = await llm.complete(req);
  const b = await llm.complete(req);
  assert.deepEqual(validate(a.json, shape), []);
  assert.deepEqual(a.json, b.json);
  const c = await llm.complete({ ...req, user: "analyse AMD" });
  assert.notDeepEqual(a.json, c.json);
});
