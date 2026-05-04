// Status workflow definitions keyed by project type code (string, not enum)
// These define the valid status progressions for each project type

const WORKFLOWS: Record<string, string[]> = {
  revizie_centrala: ["draft", "scheduled", "in_progress", "completed"],
  bransament: [
    "draft",
    "in_progress",
    "documents_pending",
    "submitted",
    "approved",
    "completed",
    "rejected",
  ],
  conducta: [
    "draft",
    "in_progress",
    "documents_pending",
    "submitted",
    "approved",
    "completed",
    "rejected",
  ],
  dosar_iscir: [
    "draft",
    "in_progress",
    "documents_pending",
    "submitted",
    "approved",
    "completed",
    "rejected",
  ],
};

const DEFAULT_WORKFLOW = [
  "draft",
  "in_progress",
  "completed",
  "cancelled",
];

export function getStatusesForType(typeCode: string): string[] {
  return WORKFLOWS[typeCode] ?? DEFAULT_WORKFLOW;
}

export function getValidNextStatuses(
  typeCode: string,
  current: string
): string[] {
  const workflow = WORKFLOWS[typeCode] ?? DEFAULT_WORKFLOW;
  const currentIndex = workflow.indexOf(current);

  if (currentIndex === -1) return [];

  if (current === "rejected") {
    return ["in_progress"];
  }

  return workflow.filter((s, i) => i > currentIndex && s !== "rejected");
}

export function validateStatusTransition(
  typeCode: string,
  current: string,
  next: string
): void {
  const valid = getValidNextStatuses(typeCode, current);

  if (
    next === "rejected" &&
    (current === "submitted" || current === "approved")
  ) {
    return;
  }

  if (!valid.includes(next)) {
    throw new Error(
      `Invalid status transition for ${typeCode}: ${current} → ${next}`
    );
  }
}
