import { describe, test, expect } from "bun:test";
import { evaluateFlag, isRuleSatisfied } from "../src/flags/eval.js";
import { bucketFor, weightedSlot, fnv1a32Hex } from "../src/hash.js";
import type { EvalContext, FlagDefinition } from "../src/types.js";

const flag: FlagDefinition = {
  key: "test.flag",
  description: "",
  enabled: true,
  rollout: 50,
};

describe("hashing", () => {
  test("fnv1a32Hex is deterministic and well-distributed", () => {
    expect(fnv1a32Hex(new TextEncoder().encode("hello"))).toBe(fnv1a32Hex(new TextEncoder().encode("hello")));
    expect(fnv1a32Hex(new TextEncoder().encode("hello"))).not.toBe(fnv1a32Hex(new TextEncoder().encode("hellp")));
  });

  test("bucketFor is stable and inside 0..99", () => {
    const a = bucketFor("test.flag", "user-1");
    expect(a).toBe(bucketFor("test.flag", "user-1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(99);
  });

  test("bucketFor differs per flag key", () => {
    expect(bucketFor("a", "user-1")).not.toBe(bucketFor("b", "user-1"));
  });

  test("weightedSlot stays within declared weights", () => {
    const variants = [
      { name: "a", weight: 50 },
      { name: "b", weight: 30 },
      { name: "c", weight: 20 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 1000; i++) {
      const slot = weightedSlot(variants, bucketFor("v", `u-${i}`));
      if (slot === null) throw new Error("unreachable: three positive weights");
      counts[slot.name] = (counts[slot.name] ?? 0) + 1;
    }
    expect(counts["a"]).toBeGreaterThan(400);
    expect(counts["b"]).toBeGreaterThan(200);
    expect(counts["c"]).toBeGreaterThan(100);
    expect(weightedSlot([], 50)).toBeNull();
  });
});

describe("evaluateFlag", () => {
  test("undefined flag is disabled", () => {
    const result = evaluateFlag(undefined, { id: "u-1" });
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("flag-not-found");
  });

  test("disabled flag reports kill switch", () => {
    const result = evaluateFlag({ ...flag, enabled: false }, { id: "u-1" });
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("flag-disabled");
  });

  test("rollout 0 keeps everyone out, 100 lets everyone in", () => {
    for (let i = 0; i < 50; i++) {
      expect(evaluateFlag({ ...flag, rollout: 0 }, { id: `u-${i}` }).enabled).toBe(false);
      expect(evaluateFlag({ ...flag, rollout: 100 }, { id: `u-${i}` }).enabled).toBe(true);
    }
  });

  test("50% rollout is roughly half of a large cohort", () => {
    let inside = 0;
    for (let i = 0; i < 1000; i++) {
      if (evaluateFlag(flag, { id: `u-${i}` }).enabled) inside++;
    }
    expect(inside).toBeGreaterThan(400);
    expect(inside).toBeLessThan(600);
  });

  test("bucketing is stable across evaluations", () => {
    const first = evaluateFlag(flag, { id: "stable-user" });
    for (let i = 0; i < 10; i++) {
      expect(evaluateFlag(flag, { id: "stable-user" })).toEqual(first);
    }
  });

  test("targeting rule admits only matching attributes", () => {
    const targeted: FlagDefinition = { ...flag, rollout: 100, rules: [{ attribute: "plan", operator: "equals", values: ["pro"] }] };
    expect(evaluateFlag(targeted, { id: "u", attributes: { plan: "pro" } }).enabled).toBe(true);
    const free = evaluateFlag(targeted, { id: "u", attributes: { plan: "free" } });
    expect(free.enabled).toBe(false);
    expect(free.reason).toBe("rule-no-match");
  });

  test("equals-any satisfies when any value matches", () => {
    const targeted: FlagDefinition = { ...flag, rollout: 100, rules: [{ attribute: "region", operator: "equals-any", values: ["us", "eu"] }] };
    expect(evaluateFlag(targeted, { id: "u", attributes: { region: "eu" } }).enabled).toBe(true);
    expect(evaluateFlag(targeted, { id: "u", attributes: { region: "apac" } }).enabled).toBe(false);
  });

  test("not-equals excludes listed values", () => {
    const targeted: FlagDefinition = { ...flag, rollout: 100, rules: [{ attribute: "tier", operator: "not-equals", values: ["internal"] }] };
    expect(evaluateFlag(targeted, { id: "u", attributes: { tier: "paid" } }).enabled).toBe(true);
    expect(evaluateFlag(targeted, { id: "u", attributes: { tier: "internal" } }).enabled).toBe(false);
  });

  test("exists operator distinguishes missing from present", () => {
    const targeted: FlagDefinition = { ...flag, rollout: 100, rules: [{ attribute: "beta", operator: "exists", values: [] }] };
    expect(evaluateFlag(targeted, { id: "u", attributes: { beta: "true" } }).enabled).toBe(true);
    expect(evaluateFlag(targeted, { id: "u", attributes: {} }).enabled).toBe(false);
    expect(evaluateFlag(targeted, { id: "u" }).enabled).toBe(false);
  });

  test("multiple rules AND together", () => {
    const targeted: FlagDefinition = {
      ...flag,
      rollout: 100,
      rules: [
        { attribute: "plan", operator: "equals", values: ["pro"] },
        { attribute: "region", operator: "equals", values: ["us"] },
      ],
    };
    expect(evaluateFlag(targeted, { id: "u", attributes: { plan: "pro", region: "us" } }).enabled).toBe(true);
    expect(evaluateFlag(targeted, { id: "u", attributes: { plan: "pro", region: "eu" } }).enabled).toBe(false);
  });

  test("variant selected after rules and rollout", () => {
    const withVariants: FlagDefinition = {
      ...flag,
      rollout: 100,
      variants: [
        { name: "control", weight: 50 },
        { name: "treatment", weight: 50, payload: { color: "blue" } },
      ],
    };
    const a = evaluateFlag(withVariants, { id: "u-1" });
    const b = evaluateFlag(withVariants, { id: "u-2" });
    expect(a.enabled).toBe(true);
    expect(a.variant).not.toBeNull();
    expect(b.enabled).toBe(true);
    expect(b.variant).not.toBeNull();
    expect(["control", "treatment"]).toContain(a.variant);
    expect(evaluateFlag(withVariants, { id: "u-1" })).toEqual(a);
  });

  test("variant skipped when rollout excludes", () => {
    const withVariants: FlagDefinition = {
      ...flag,
      rollout: 0,
      variants: [{ name: "control", weight: 100 }],
    };
    const result = evaluateFlag(withVariants, { id: "u-1" });
    expect(result.enabled).toBe(false);
    expect(result.variant).toBeNull();
  });

  test("invalid weights sum is reported", () => {
    const broken: FlagDefinition = {
      ...flag,
      rollout: 100,
      variants: [
        { name: "a", weight: 50 },
        { name: "b", weight: 60 },
      ],
    };
    const result = evaluateFlag(broken, { id: "u-1" });
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("invalid-variant-weights");
  });

  test("zero total weight falls back to first variant", () => {
    const broken: FlagDefinition = {
      ...flag,
      rollout: 100,
      variants: [
        { name: "a", weight: 0 },
        { name: "b", weight: 0 },
      ],
    };
    const result = evaluateFlag(broken, { id: "u-1" });
    expect(result.variant).toBe("a");
  });

  test("isRuleSatisfied direct checks", () => {
    expect(isRuleSatisfied({ attribute: "a", operator: "equals", values: ["1"] }, { a: "1" })).toBe(true);
    expect(isRuleSatisfied({ attribute: "a", operator: "equals", values: ["1"] }, {})).toBe(false);
    expect(isRuleSatisfied({ attribute: "a", operator: "not-equals", values: ["1"] }, {})).toBe(false);
  });
});
