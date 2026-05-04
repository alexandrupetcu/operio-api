/**
 * Safe JSON rules engine for evaluating workflow transition conditions.
 * NO eval() or Function() - purely data-driven evaluation.
 *
 * Supports combinators: all (AND), any (OR)
 * Supports operators: equal, notEqual, greaterThan, lessThan,
 *   greaterThanOrEqual, lessThanOrEqual, contains, in, exists, notExists
 */

type Operator =
  | "equal"
  | "notEqual"
  | "greaterThan"
  | "lessThan"
  | "greaterThanOrEqual"
  | "lessThanOrEqual"
  | "contains"
  | "in"
  | "exists"
  | "notExists";

interface ConditionRule {
  fact: string;
  operator: Operator;
  value?: unknown;
}

interface ConditionGroup {
  all?: Array<ConditionRule | ConditionGroup>;
  any?: Array<ConditionRule | ConditionGroup>;
}

type Condition = ConditionRule | ConditionGroup;

/**
 * Resolve a dot-path against a context object.
 * e.g. "step_output.requires_permits" resolves context.step_output.requires_permits
 */
function resolveFact(path: string, context: Record<string, unknown>): unknown {
  const segments = path.split(".");
  let current: unknown = context;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function evaluateOperator(
  operator: Operator,
  factValue: unknown,
  ruleValue: unknown
): boolean {
  switch (operator) {
    case "equal":
      return factValue === ruleValue;

    case "notEqual":
      return factValue !== ruleValue;

    case "greaterThan":
      return (
        typeof factValue === "number" &&
        typeof ruleValue === "number" &&
        factValue > ruleValue
      );

    case "lessThan":
      return (
        typeof factValue === "number" &&
        typeof ruleValue === "number" &&
        factValue < ruleValue
      );

    case "greaterThanOrEqual":
      return (
        typeof factValue === "number" &&
        typeof ruleValue === "number" &&
        factValue >= ruleValue
      );

    case "lessThanOrEqual":
      return (
        typeof factValue === "number" &&
        typeof ruleValue === "number" &&
        factValue <= ruleValue
      );

    case "contains":
      if (typeof factValue === "string" && typeof ruleValue === "string") {
        return factValue.includes(ruleValue);
      }
      if (Array.isArray(factValue)) {
        return factValue.includes(ruleValue);
      }
      return false;

    case "in":
      if (Array.isArray(ruleValue)) {
        return ruleValue.includes(factValue);
      }
      return false;

    case "exists":
      return factValue !== undefined && factValue !== null;

    case "notExists":
      return factValue === undefined || factValue === null;

    default:
      return false;
  }
}

function isConditionGroup(condition: Condition): condition is ConditionGroup {
  return "all" in condition || "any" in condition;
}

function evaluateSingle(
  condition: Condition,
  context: Record<string, unknown>
): boolean {
  if (isConditionGroup(condition)) {
    return evaluateGroup(condition, context);
  }

  const factValue = resolveFact(condition.fact, context);
  return evaluateOperator(condition.operator, factValue, condition.value);
}

function evaluateGroup(
  group: ConditionGroup,
  context: Record<string, unknown>
): boolean {
  if (group.all) {
    return group.all.every((child) => evaluateSingle(child, context));
  }

  if (group.any) {
    return group.any.some((child) => evaluateSingle(child, context));
  }

  // Empty group with no combinators evaluates to true
  return true;
}

/**
 * Evaluate a condition object against a context.
 * Returns true if condition is null/undefined (no condition means always match).
 */
export function evaluateCondition(
  condition: unknown,
  context: Record<string, unknown>
): boolean {
  if (condition === null || condition === undefined) {
    return true;
  }

  if (typeof condition !== "object") {
    return false;
  }

  return evaluateSingle(condition as Condition, context);
}
