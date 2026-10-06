import type { FastifyInstance } from "fastify";
import { logEvent } from "./execution-logger.js";

/**
 * Workflow-driven project status.
 *
 * When a workflow step carries `configJson.projectStatus`, applying/activating
 * that step moves the attached project to that status. This makes the workflow
 * the source of truth for `project.status` (the manual status dropdown becomes a
 * fallback/override). Opt-in per step: steps without `projectStatus` change
 * nothing, so existing workflows keep the manual behaviour.
 *
 * Idempotent (skips when already at the target) and best-effort (failures are
 * logged, never thrown — status sync must never break step activation).
 */
export async function applyStepProjectStatus(
  fastify: FastifyInstance,
  tenantId: string,
  ref: { entityType?: string | null; entityId?: string | null; workflowInstanceId: string },
  stepConfigJson: unknown,
  stepInstanceId: string | null,
): Promise<void> {
  if (ref.entityType !== "project" || !ref.entityId) return;

  const cfg =
    stepConfigJson && typeof stepConfigJson === "object"
      ? (stepConfigJson as Record<string, unknown>)
      : {};
  const target =
    typeof cfg.projectStatus === "string" && cfg.projectStatus.trim()
      ? cfg.projectStatus.trim()
      : null;
  if (!target) return;

  try {
    const project = await fastify.prisma.project.findFirst({
      where: { id: ref.entityId, tenantId },
      select: { status: true },
    });
    if (!project || project.status === target) return;

    await fastify.prisma.project.update({
      where: { id: ref.entityId },
      data: { status: target },
    });

    await logEvent(fastify, tenantId, ref.workflowInstanceId, stepInstanceId, "project_status_changed", {
      from: project.status,
      to: target,
    });
  } catch (err) {
    fastify.log.error(
      { err, projectId: ref.entityId, target },
      "Failed to apply workflow-driven project status",
    );
  }
}
