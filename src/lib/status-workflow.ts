import type { ProjectType, ProjectStatus } from "@prisma/client";

const WORKFLOWS: Record<ProjectType, ProjectStatus[]> = {
  REVIZIE_CENTRALA: ["DRAFT", "SCHEDULED", "IN_PROGRESS", "COMPLETED"],
  BRANSAMENT: [
    "DRAFT",
    "IN_PROGRESS",
    "DOCUMENTS_PENDING",
    "SUBMITTED",
    "APPROVED",
    "COMPLETED",
    "REJECTED",
  ],
  CONDUCTA: [
    "DRAFT",
    "IN_PROGRESS",
    "DOCUMENTS_PENDING",
    "SUBMITTED",
    "APPROVED",
    "COMPLETED",
    "REJECTED",
  ],
  DOSAR_ISCIR: [
    "DRAFT",
    "IN_PROGRESS",
    "DOCUMENTS_PENDING",
    "SUBMITTED",
    "APPROVED",
    "COMPLETED",
    "REJECTED",
  ],
};

export function getStatusesForType(type: ProjectType): ProjectStatus[] {
  return WORKFLOWS[type];
}

export function getValidNextStatuses(
  type: ProjectType,
  current: ProjectStatus
): ProjectStatus[] {
  const workflow = WORKFLOWS[type];
  const currentIndex = workflow.indexOf(current);

  if (currentIndex === -1) return [];

  // REJECTED can go back to IN_PROGRESS
  if (current === "REJECTED") {
    return ["IN_PROGRESS"];
  }

  // Can move to any later status in the workflow (skip allowed)
  return workflow.filter((_, i) => i > currentIndex && workflow[i] !== "REJECTED");
}

export function validateStatusTransition(
  type: ProjectType,
  current: ProjectStatus,
  next: ProjectStatus
): void {
  const valid = getValidNextStatuses(type, current);

  // Also allow REJECTED from SUBMITTED or APPROVED
  if (
    next === "REJECTED" &&
    (current === "SUBMITTED" || current === "APPROVED")
  ) {
    return;
  }

  if (!valid.includes(next)) {
    throw new Error(
      `Invalid status transition for ${type}: ${current} → ${next}`
    );
  }
}
