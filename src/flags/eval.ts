import type { EvalContext, EvalResult, FlagDefinition, TargetingRule } from "../types.js";
import { FeatureFlagError } from "../errors.js";
import { bucketFor, weightedSlot } from "../hash.js";

const VALID_OPERATORS = ["equals", "equals-any", "not-equals", "exists"] as const;

/**
 * Flag keys are slash-separated segments of [a-zA-Z0-9._-], each starting
 * alphanumeric, at most 200 characters total. The rules keep blob paths
 * predictable and make keys legible in CLIs and audit trails.
 */
export function isValidFlagKey(key: string): boolean {
  if (key.length === 0 || key.length > 200) return false;
  if (key.startsWith("/") || key.endsWith("/") || key.includes("//")) return false;
  return key.split("/").every((segment) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment));
}

/**
 * Evaluates one targeting rule against one attribute bag. A rule only counts
 * as satisfied when the attribute is present — absence never satisfies any
 * operator, including not-equals, which keeps "unknown user property" from
 * silently matching "user is not in the list".
 */
export function isRuleSatisfied(rule: TargetingRule, attributes: Readonly<Record<string, string>>): boolean {
  const raw = attributes[rule.attribute];
  if (raw === undefined) return false;
  if (rule.operator === "exists") return true;
  const value = String(raw);
  switch (rule.operator) {
    case "equals":
    case "equals-any":
      return rule.values.includes(value);
    case "not-equals":
      return !rule.values.includes(value);
    default: {
      const exhaustive: never = rule.operator;
      throw new FeatureFlagError("VALIDATION", `unknown operator ${(exhaustive as string)}`);
    }
  }
}

/**
 * Pure evaluation of one flag definition against one context.
 *
 * Ordering: flag existence -> kill switch -> targeting rules (first match
 * wins; all rules must hold for the flag to be targeted) -> percentage
 * rollout -> variant assignment. All randomization is deterministic hashing
 * of (flag key, context id), so the same subject always gets the same answer
 * — the defining property of a consistent rollout without sticky sessions.
 */
export function evaluateFlag(definition: FlagDefinition | undefined, context: EvalContext): EvalResult {
  const bucket = bucketFor(definition?.key ?? "", context.id);
  if (definition === undefined) {
    return { flagKey: "", enabled: false, reason: "flag-not-found", variant: null, payload: null, bucket };
  }
  if (!definition.enabled) {
    return { flagKey: definition.key, enabled: false, reason: "flag-disabled", variant: null, payload: null, bucket };
  }

  const attributes = context.attributes ?? {};
  const rules = definition.rules ?? [];
  if (rules.length > 0 && !rules.every((rule) => isRuleSatisfied(rule, attributes))) {
    return { flagKey: definition.key, enabled: false, reason: "rule-no-match", variant: null, payload: null, bucket };
  }

  if (bucket >= definition.rollout) {
    return { flagKey: definition.key, enabled: false, reason: "rollout-excluded", variant: null, payload: null, bucket };
  }

  const variants = definition.variants ?? [];
  if (variants.length === 0) {
    return { flagKey: definition.key, enabled: true, reason: "enabled", variant: null, payload: null, bucket };
  }

  const totalWeight = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (totalWeight > 100) {
    return {
      flagKey: definition.key,
      enabled: false,
      reason: "invalid-variant-weights",
      variant: null,
      payload: null,
      bucket,
    };
  }
  const chosen = totalWeight === 0 ? (variants[0] ?? null) : weightedSlot(variants, bucket);
  return {
    flagKey: definition.key,
    enabled: true,
    reason: "enabled",
    variant: chosen?.name ?? null,
    payload: chosen && "payload" in chosen && chosen.payload !== undefined ? chosen.payload : null,
    bucket,
  };
}

/** Validates a definition's invariants; throws FeatureFlagError("VALIDATION") on violation. */
export function validateDefinition(definition: FlagDefinition): void {
  if (!isValidFlagKey(definition.key)) {
    throw new FeatureFlagError(
      "VALIDATION",
      `invalid flag key "${definition.key}": slash-separated segments of [a-zA-Z0-9._-], each starting alphanumeric, at most 200 characters`,
    );
  }
  if (!Number.isInteger(definition.rollout) || definition.rollout < 0 || definition.rollout > 100) {
    throw new FeatureFlagError("VALIDATION", `rollout must be an integer in [0, 100], got ${definition.rollout}`);
  }
  const variantNames = new Set<string>();
  for (const variant of definition.variants ?? []) {
    if (variant.name.length === 0) throw new FeatureFlagError("VALIDATION", "variant names must be non-empty");
    if (variantNames.has(variant.name)) {
      throw new FeatureFlagError("VALIDATION", `duplicate variant name "${variant.name}"`);
    }
    variantNames.add(variant.name);
    if (!Number.isFinite(variant.weight) || variant.weight < 0) {
      throw new FeatureFlagError("VALIDATION", `variant "${variant.name}" weight must be a finite number >= 0`);
    }
  }
  for (const rule of definition.rules ?? []) {
    if (rule.attribute.length === 0) {
      throw new FeatureFlagError("VALIDATION", `rule on "${rule.operator}" needs a non-empty attribute`);
    }
    if (!VALID_OPERATORS.includes(rule.operator)) {
      throw new FeatureFlagError("VALIDATION", `rule on "${rule.attribute}" has unknown operator "${rule.operator}"`);
    }
    if (rule.operator !== "exists" && rule.values.length === 0) {
      throw new FeatureFlagError("VALIDATION", `rule on "${rule.attribute}" (${rule.operator}) needs at least one value`);
    }
  }
}
