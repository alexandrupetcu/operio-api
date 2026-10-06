import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import { validateStatusTransition } from "../../lib/status-workflow.js";
import { findPrimaryWorkflowFor } from "../workflow-definitions/workflow-definitions.service.js";
import { applyStepProjectStatus } from "../../lib/workflow-engine/project-status-sync.js";
import type {
  CreateProjectInput,
  UpdateProjectInput,
  CreateProjectWithClientInput,
} from "./projects.schema.js";

/**
 * After a project is created, try to find and start its primary workflow.
 * Failure is logged but never thrown — project creation succeeds regardless.
 */
async function tryAutoStartPrimaryWorkflow(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
  projectTypeId: string,
  distributorId: string | null,
  userId: string
): Promise<void> {
  try {
    const definition = await findPrimaryWorkflowFor(
      fastify,
      tenantId,
      projectTypeId,
      distributorId
    );

    if (!definition) {
      fastify.log.info(
        { projectId, projectTypeId, distributorId },
        "No primary workflow configured for this (projectType, distributor) — project created without workflow"
      );
      return;
    }

    const startStep = await fastify.prisma.workflowStep.findFirst({
      where: { workflowDefinitionId: definition.id, isStart: true },
    });
    if (!startStep) {
      fastify.log.warn(
        { projectId, definitionId: definition.id },
        "Primary workflow has no start step — skipping auto-start"
      );
      return;
    }

    const now = new Date();
    const instance = await fastify.prisma.workflowInstance.create({
      data: {
        tenantId,
        workflowDefinitionId: definition.id,
        entityType: "project",
        entityId: projectId,
        status: "active",
        currentStepCode: startStep.code,
        startedAt: now,
        stepInstances: {
          create: {
            tenantId,
            stepDefinitionId: startStep.id,
            status: "active",
            startedAt: now,
          },
        },
      },
    });

    await fastify.prisma.workflowExecutionLog.create({
      data: {
        tenantId,
        workflowInstanceId: instance.id,
        eventType: "workflow_started",
        payloadJson: {
          definitionCode: definition.code,
          definitionName: definition.name,
          entityType: "project",
          entityId: projectId,
          startStepCode: startStep.code,
          userId,
          autoStarted: true,
        } as Prisma.InputJsonValue,
      },
    });

    await fastify.prisma.project.update({
      where: { id: projectId },
      data: { currentWorkflowInstanceId: instance.id },
    });

    // Workflow-driven project status: apply the start step's configJson.projectStatus (if any).
    await applyStepProjectStatus(
      fastify,
      tenantId,
      { entityType: "project", entityId: projectId, workflowInstanceId: instance.id },
      startStep.configJson,
      null,
    );

    fastify.log.info(
      { projectId, workflowInstanceId: instance.id, definitionCode: definition.code },
      "Auto-started primary workflow for new project"
    );
  } catch (err) {
    fastify.log.error(
      { err, projectId },
      "Failed to auto-start primary workflow — project remains without workflow"
    );
  }
}

const clientSelect = {
  id: true,
  type: true,
  companyName: true,
  firstName: true,
  lastName: true,
  addresses: {
    include: {
      city: { select: { id: true, name: true } },
      state: { select: { id: true, name: true } },
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] as any,
  },
  phone: true,
  email: true,
} as const;

const listInclude = {
  client: { select: clientSelect },
  projectType: { select: { id: true, code: true, name: true } },
  assignedEmployee: {
    select: { id: true, firstName: true, lastName: true, position: true },
  },
} as const;

const detailInclude = {
  client: {
    include: {
      addresses: {
        include: {
          city: { select: { id: true, name: true } },
          state: { select: { id: true, name: true } },
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] as any,
      },
    },
  },
  projectType: { select: { id: true, code: true, name: true } },
  distributor: { select: { id: true, name: true } },
  assignedEmployee: {
    select: { id: true, firstName: true, lastName: true, position: true },
  },
  documents: { orderBy: { createdAt: "desc" as const } },
} as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & { status?: string; projectTypeId?: string; kind?: string }
) {
  // Default to kind="project" so the regular Proiecte page never shows
  // quick_dossier rows (those live only on the client detail page). Caller can
  // pass kind="all" to include both, or kind="quick_dossier" to fetch only those.
  const kindFilter =
    query.kind === "all"
      ? undefined
      : query.kind
        ? { kind: query.kind }
        : { kind: "project" };
  const where = {
    tenantId,
    ...kindFilter,
    ...(query.status && { status: query.status }),
    ...(query.projectTypeId && { projectTypeId: query.projectTypeId }),
    ...(query.search && {
      OR: [
        { name: { contains: query.search, mode: "insensitive" as const } },
        { address: { contains: query.search, mode: "insensitive" as const } },
        {
          client: {
            companyName: { contains: query.search, mode: "insensitive" as const },
          },
        },
        {
          client: {
            firstName: { contains: query.search, mode: "insensitive" as const },
          },
        },
        {
          client: {
            lastName: { contains: query.search, mode: "insensitive" as const },
          },
        },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.project.findMany({
      where,
      include: listInclude,
      ...paginationArgs(query),
    }),
    fastify.prisma.project.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

/** KPI counts for the Proiecte page header. */
export async function stats(fastify: FastifyInstance, tenantId: string) {
  const now = new Date();
  const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const terminal = ["completed", "rejected", "cancelled"];

  // All stats exclude quick_dossier rows so KPI counts reflect real projects only.
  const baseFilter = { tenantId, kind: "project" };
  const [total, completed, draft, inProgress, overdue, dueSoon] = await Promise.all([
    fastify.prisma.project.count({ where: baseFilter }),
    fastify.prisma.project.count({ where: { ...baseFilter, status: "completed" } }),
    fastify.prisma.project.count({ where: { ...baseFilter, status: "draft" } }),
    fastify.prisma.project.count({ where: { ...baseFilter, status: "in_progress" } }),
    fastify.prisma.project.count({
      where: { ...baseFilter, status: { notIn: terminal }, scheduledDate: { lt: now } },
    }),
    fastify.prisma.project.count({
      where: { ...baseFilter, status: { notIn: terminal }, scheduledDate: { gte: now, lte: in7 } },
    }),
  ]);

  return { total, active: total - completed, completed, draft, inProgress, overdue, dueSoon };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const project = await fastify.prisma.project.findFirst({
    where: { id, tenantId },
    include: detailInclude,
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");
  return project;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: CreateProjectInput
) {
  const client = await fastify.prisma.client.findFirst({
    where: { id: input.clientId, tenantId },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");

  const projectType = await fastify.prisma.projectType.findFirst({
    where: { id: input.projectTypeId, tenantId },
  });
  if (!projectType) throw fastify.httpErrors.notFound("Project type not found");

  if (input.distributorId) {
    const distributor = await fastify.prisma.distributor.findFirst({
      where: { id: input.distributorId, tenantId },
    });
    if (!distributor) throw fastify.httpErrors.notFound("Distributor not found");
  }

  if (input.assignedEmployeeId) {
    const emp = await fastify.prisma.employee.findFirst({
      where: { id: input.assignedEmployeeId, tenantId },
    });
    if (!emp) throw fastify.httpErrors.notFound("Employee not found");
  }

  const initialStatus =
    input.scheduledDate && projectType.code === "revizie_centrala"
      ? "scheduled"
      : "draft";

  const project = await fastify.prisma.project.create({
    data: {
      tenantId,
      clientId: input.clientId,
      projectTypeId: input.projectTypeId,
      distributorId: input.distributorId ?? null,
      name: input.name,
      address: input.address,
      city: input.city,
      county: input.county,
      observations: input.observations ?? null,
      participareISC: input.participareISC ?? false,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
      scheduledDate: input.scheduledDate ? new Date(input.scheduledDate) : null,
      assignedEmployeeId: input.assignedEmployeeId ?? null,
      status: initialStatus,
    },
    include: listInclude,
  });

  await tryAutoStartPrimaryWorkflow(
    fastify,
    tenantId,
    project.id,
    project.projectTypeId,
    project.distributorId,
    userId
  );

  // Re-fetch to include currentWorkflowInstanceId set by auto-start
  return fastify.prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    include: listInclude,
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateProjectInput
) {
  const project = await fastify.prisma.project.findFirst({
    where: { id, tenantId },
    include: { projectType: true },
  });
  if (!project) throw fastify.httpErrors.notFound("Project not found");

  // Validate status transition if status is being changed
  if (input.status && input.status !== project.status) {
    try {
      validateStatusTransition(project.projectType.code, project.status, input.status);
    } catch {
      throw fastify.httpErrors.badRequest(
        `Invalid status transition: ${project.status} → ${input.status}`
      );
    }
  }

  if (input.assignedEmployeeId) {
    const emp = await fastify.prisma.employee.findFirst({
      where: { id: input.assignedEmployeeId, tenantId },
    });
    if (!emp) throw fastify.httpErrors.notFound("Employee not found");
  }

  return fastify.prisma.project.update({
    where: { id },
    data: {
      ...input,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
      ...(input.scheduledDate !== undefined && {
        scheduledDate: input.scheduledDate ? new Date(input.scheduledDate) : null,
      }),
    },
    include: listInclude,
  });
}

export async function createWithClient(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: CreateProjectWithClientInput
) {
  const project = await fastify.prisma.$transaction(async (tx) => {
    let clientId: string;

    if ("id" in input.client) {
      const client = await tx.client.findFirst({
        where: { id: input.client.id, tenantId },
      });
      if (!client) throw fastify.httpErrors.notFound("Client not found");
      clientId = client.id;
    } else {
      const { contactPersons, equipment, addresses, ...clientData } =
        input.client.type === "COMPANY"
          ? input.client
          : { ...input.client, contactPersons: undefined };

      const newClient = await tx.client.create({
        data: {
          tenantId,
          ...clientData,
          ...(addresses?.length && {
            addresses: {
              create: addresses.map(({ id: _id, ...addr }) => addr),
            },
          }),
          ...(contactPersons?.length && {
            contactPersons: {
              create: contactPersons.map(({ id: _id, ...cp }) => cp),
            },
          }),
          ...(equipment?.length && {
            equipment: {
              create: equipment.map(({ id: _id, ...eq }) => ({
                type: eq.type ?? "CENTRALA",
                internalName: eq.internalName,
                fuel: eq.fuel,
                serial: eq.serial,
              })),
            },
          }),
        },
      } as any);
      clientId = newClient.id;
    }

    const projectType = await tx.projectType.findFirst({
      where: { id: input.project.projectTypeId, tenantId },
    });
    if (!projectType) throw fastify.httpErrors.notFound("Project type not found");

    if (input.project.distributorId) {
      const distributor = await tx.distributor.findFirst({
        where: { id: input.project.distributorId, tenantId },
      });
      if (!distributor) throw fastify.httpErrors.notFound("Distributor not found");
    }

    if (input.scheduling?.assignedEmployeeId) {
      const emp = await tx.employee.findFirst({
        where: { id: input.scheduling.assignedEmployeeId, tenantId },
      });
      if (!emp) throw fastify.httpErrors.notFound("Employee not found");
    }

    const initialStatus =
      input.scheduling?.scheduledDate && projectType.code === "revizie_centrala"
        ? "scheduled"
        : "draft";

    const created = await tx.project.create({
      data: {
        tenantId,
        clientId,
        projectTypeId: input.project.projectTypeId,
        distributorId: input.project.distributorId ?? null,
        name: input.project.name,
        address: input.project.address,
        city: input.project.city,
        county: input.project.county,
        observations: input.project.observations ?? null,
        participareISC: input.project.participareISC ?? false,
        metadata: input.project.metadata as Prisma.InputJsonValue | undefined,
        scheduledDate: input.scheduling?.scheduledDate
          ? new Date(input.scheduling.scheduledDate)
          : null,
        assignedEmployeeId: input.scheduling?.assignedEmployeeId ?? null,
        status: initialStatus,
      },
      include: {
        client: true,
        projectType: { select: { id: true, code: true, name: true } },
        assignedEmployee: {
          select: { id: true, firstName: true, lastName: true, position: true },
        },
      },
    });

    return created;
  });

  await tryAutoStartPrimaryWorkflow(
    fastify,
    tenantId,
    project.id,
    project.projectTypeId,
    project.distributorId,
    userId
  );

  return project;
}

export async function calendar(
  fastify: FastifyInstance,
  tenantId: string,
  from: string,
  to: string
) {
  return fastify.prisma.project.findMany({
    where: {
      tenantId,
      scheduledDate: {
        gte: new Date(from),
        lte: new Date(to),
      },
    },
    include: listInclude,
    orderBy: { scheduledDate: "asc" },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.project.delete({ where: { id } });
}

/**
 * Audit-trail of snooze/unsnooze/dismiss events from the dashboard
 * "De făcut acum" feed that belong to this project.
 *
 * The action-feed `actionKey` follows one of three patterns the project owns:
 *   - "project-<projectId>"           (project itself)
 *   - "task-<taskId>"                 (any Task linked to the project)
 *   - "step-<stepInstanceId>"         (any WorkflowStepInstance under the project's workflow)
 *
 * We resolve the universe of keys with two cheap queries (tasks + step instances),
 * then a single `findMany` on ActionFeedSnoozeNote. Each row is enriched with the
 * step it relates to (when any) so the UI can group / filter per step.
 */
export interface ProjectSnoozeHistoryItem {
  id: string;
  actionKey: string;
  kind: string;
  eventType: string;
  until: string | null;
  note: string | null;
  authorName: string;
  createdAt: string;
  stepInstanceId: string | null;
  stepName: string | null;
}

export async function getProjectSnoozeHistory(
  fastify: FastifyInstance,
  tenantId: string,
  projectId: string,
): Promise<ProjectSnoozeHistoryItem[]> {
  await getById(fastify, tenantId, projectId);

  const [tasks, stepInstances] = await Promise.all([
    fastify.prisma.task.findMany({
      where: { tenantId, projectId, deletedAt: null },
      select: { id: true, workflowStepInstanceId: true },
    }),
    fastify.prisma.workflowStepInstance.findMany({
      where: { tenantId, workflowInstance: { entityId: projectId } },
      select: {
        id: true,
        displayName: true,
        stepDefinition: { select: { name: true } },
      },
    }),
  ]);

  const actionKeys = [
    `project-${projectId}`,
    ...tasks.map((t) => `task-${t.id}`),
    ...stepInstances.map((s) => `step-${s.id}`),
  ];

  if (actionKeys.length === 0) return [];

  const notes = await fastify.prisma.actionFeedSnoozeNote.findMany({
    where: { tenantId, actionKey: { in: actionKeys } },
    orderBy: { createdAt: "desc" },
  });

  const stepNameById = new Map<string, string>(
    stepInstances.map((s) => [s.id, s.displayName || s.stepDefinition?.name || "Pas"]),
  );
  const taskStepById = new Map<string, string | null>(
    tasks.map((t) => [t.id, t.workflowStepInstanceId]),
  );

  return notes.map((n) => {
    let stepInstanceId: string | null = null;
    if (n.actionKey.startsWith("step-")) {
      stepInstanceId = n.actionKey.slice("step-".length);
    } else if (n.actionKey.startsWith("task-")) {
      stepInstanceId = taskStepById.get(n.actionKey.slice("task-".length)) ?? null;
    }
    return {
      id: n.id,
      actionKey: n.actionKey,
      kind: n.kind,
      eventType: n.eventType,
      until: n.until ? n.until.toISOString() : null,
      note: n.note,
      authorName: n.authorName,
      createdAt: n.createdAt.toISOString(),
      stepInstanceId,
      stepName: stepInstanceId ? stepNameById.get(stepInstanceId) ?? null : null,
    };
  });
}
