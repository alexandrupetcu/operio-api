/**
 * Calculates availableAt and dueAt from workflow step configuration.
 *
 * Supports:
 * - due_policy with type "relative", base ("previous_step_completed_at" | "workflow_started_at"), offset { days, hours, minutes }
 * - Fallback to estimatedDays from config
 */

interface DueOffset {
  days?: number;
  hours?: number;
  minutes?: number;
}

interface DuePolicy {
  type: "relative";
  base: "previous_step_completed_at" | "workflow_started_at";
  offset: DueOffset;
}

interface StepConfig {
  estimatedDays?: number;
  due_policy?: DuePolicy;
  available_policy?: {
    type: "relative";
    base: "previous_step_completed_at" | "workflow_started_at";
    offset: DueOffset;
  };
}

function addOffset(date: Date, offset: DueOffset): Date {
  const result = new Date(date.getTime());
  if (offset.days) {
    result.setDate(result.getDate() + offset.days);
  }
  if (offset.hours) {
    result.setHours(result.getHours() + offset.hours);
  }
  if (offset.minutes) {
    result.setMinutes(result.getMinutes() + offset.minutes);
  }
  return result;
}

function resolveBase(
  base: string,
  previousStepCompletedAt: Date | null,
  workflowStartedAt: Date
): Date {
  if (base === "previous_step_completed_at" && previousStepCompletedAt) {
    return previousStepCompletedAt;
  }
  if (base === "workflow_started_at") {
    return workflowStartedAt;
  }
  // Fallback: use previous step completed or now
  return previousStepCompletedAt ?? new Date();
}

export function calculateDeadlines(
  stepConfig: unknown,
  previousStepCompletedAt: Date | null,
  workflowStartedAt: Date
): { availableAt: Date | null; dueAt: Date | null } {
  if (!stepConfig || typeof stepConfig !== "object") {
    return { availableAt: null, dueAt: null };
  }

  const config = stepConfig as StepConfig;
  let availableAt: Date | null = null;
  let dueAt: Date | null = null;

  // Calculate availableAt if available_policy exists
  if (config.available_policy) {
    const base = resolveBase(
      config.available_policy.base,
      previousStepCompletedAt,
      workflowStartedAt
    );
    availableAt = addOffset(base, config.available_policy.offset);
  }

  // Calculate dueAt
  if (config.due_policy) {
    const base = resolveBase(
      config.due_policy.base,
      previousStepCompletedAt,
      workflowStartedAt
    );
    dueAt = addOffset(base, config.due_policy.offset);
  } else if (config.estimatedDays !== undefined && config.estimatedDays > 0) {
    // Fallback: use estimatedDays from base = previous step completed or now
    const base = previousStepCompletedAt ?? new Date();
    dueAt = new Date(base.getTime());
    dueAt.setDate(dueAt.getDate() + config.estimatedDays);
  }

  return { availableAt, dueAt };
}
