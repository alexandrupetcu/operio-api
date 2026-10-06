interface ValidateStep {
  id: string;
  code: string;
  stepType: string;
  isStart: boolean;
  isTerminal: boolean;
  configJson: any;
}

interface ValidateTransition {
  id: string;
  fromStepId: string;
  toStepId: string;
  transitionType: string;
}

interface ValidateInput {
  steps: ValidateStep[];
  transitions: ValidateTransition[];
}

export function validateWorkflow(input: ValidateInput): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const { steps, transitions } = input;

  if (steps.length === 0) {
    errors.push("Workflow must have at least one step");
    return { valid: false, errors, warnings: [] };
  }

  const stepIds = new Set(steps.map((s) => s.id));

  // 1. Exactly one start step
  const startSteps = steps.filter((s) => s.isStart);
  if (startSteps.length === 0) {
    errors.push("Workflow must have exactly one start step");
  } else if (startSteps.length > 1) {
    errors.push(
      `Workflow must have exactly one start step, found ${startSteps.length}: ${startSteps.map((s) => s.code).join(", ")}`
    );
  }

  // 2. At least one terminal step
  const terminalSteps = steps.filter((s) => s.isTerminal);
  if (terminalSteps.length === 0) {
    errors.push("Workflow must have at least one terminal step");
  }

  // 7. Unique step codes
  const codeCounts = new Map<string, number>();
  for (const step of steps) {
    codeCounts.set(step.code, (codeCounts.get(step.code) ?? 0) + 1);
  }
  for (const [code, count] of codeCounts) {
    if (count > 1) {
      errors.push(`Duplicate step code: "${code}" (found ${count} times)`);
    }
  }

  // 8. Transitions reference valid step IDs
  for (const t of transitions) {
    if (!stepIds.has(t.fromStepId)) {
      errors.push(
        `Transition "${t.id}" references invalid fromStepId "${t.fromStepId}"`
      );
    }
    if (!stepIds.has(t.toStepId)) {
      errors.push(
        `Transition "${t.id}" references invalid toStepId "${t.toStepId}"`
      );
    }
  }

  // Build adjacency list for outgoing transitions
  const outgoing = new Map<string, ValidateTransition[]>();
  for (const step of steps) {
    outgoing.set(step.id, []);
  }
  for (const t of transitions) {
    if (stepIds.has(t.fromStepId)) {
      outgoing.get(t.fromStepId)!.push(t);
    }
  }

  // 3. All non-terminal steps have at least one outgoing transition
  //    (notification steps are auto-completing leaves — exempt)
  for (const step of steps) {
    if (!step.isTerminal && step.stepType !== "notification") {
      const out = outgoing.get(step.id) ?? [];
      if (out.length === 0) {
        errors.push(
          `Non-terminal step "${step.code}" has no outgoing transitions`
        );
      }
    }
  }

  // 5. Decision steps have at least 2 outgoing transitions
  for (const step of steps) {
    if (step.stepType === "decision") {
      const out = outgoing.get(step.id) ?? [];
      if (out.length < 2) {
        errors.push(
          `Decision step "${step.code}" must have at least 2 outgoing transitions, found ${out.length}`
        );
      }
    }
  }

  // 6. Timer steps have configJson with duration defined
  for (const step of steps) {
    if (step.stepType === "timer_wait") {
      const config =
        typeof step.configJson === "string"
          ? JSON.parse(step.configJson)
          : step.configJson;
      const hasDuration = config && (config.duration != null || config.durationDays != null);
      if (!hasDuration) {
        errors.push(
          `Timer step "${step.code}" must have a duration defined in configJson`
        );
      }
    }
  }

  // 4 & 9. All non-start steps are reachable from start (BFS) / no orphaned steps
  if (startSteps.length === 1) {
    const startStep = startSteps[0];
    const visited = new Set<string>();
    const queue: string[] = [startStep.id];
    visited.add(startStep.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const out = outgoing.get(current) ?? [];
      for (const t of out) {
        if (stepIds.has(t.toStepId) && !visited.has(t.toStepId)) {
          visited.add(t.toStepId);
          queue.push(t.toStepId);
        }
      }
    }

    for (const step of steps) {
      if (!visited.has(step.id)) {
        errors.push(
          `Step "${step.code}" is not reachable from the start step`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] as string[] };
}
