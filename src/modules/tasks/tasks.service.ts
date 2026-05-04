import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateTaskInput, UpdateTaskInput } from "./tasks.schema.js";

const listInclude = {
  project: { select: { id: true, name: true, status: true } },
  client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
  assignedUser: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

const detailInclude = {
  project: { select: { id: true, name: true, status: true } },
  client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
  assignedUser: { select: { id: true, firstName: true, lastName: true, email: true } },
  workflowInstance: { select: { id: true, status: true } },
  workflowStepInstance: { select: { id: true, stepName: true, status: true } },
} as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & {
    status?: string;
    assignedUserId?: string;
    projectId?: string;
    workflowInstanceId?: string;
  }
) {
  const where: Prisma.TaskWhereInput = {
    tenantId,
    deletedAt: null,
    ...(query.status && { status: query.status }),
    ...(query.assignedUserId && { assignedUserId: query.assignedUserId }),
    ...(query.projectId && { projectId: query.projectId }),
    ...(query.workflowInstanceId && { workflowInstanceId: query.workflowInstanceId }),
    ...(query.search && {
      OR: [
        { title: { contains: query.search, mode: "insensitive" as const } },
        { description: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.task.findMany({
      where,
      include: listInclude,
      ...paginationArgs(query),
    }),
    fastify.prisma.task.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
    include: detailInclude,
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");
  return task;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateTaskInput
) {
  return fastify.prisma.task.create({
    data: {
      tenantId,
      title: input.title,
      description: input.description,
      taskType: input.taskType,
      status: input.status,
      priority: input.priority,
      projectId: input.projectId,
      clientId: input.clientId,
      workflowInstanceId: input.workflowInstanceId,
      workflowStepInstanceId: input.workflowStepInstanceId,
      assignedUserId: input.assignedUserId,
      dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
      metadataJson: input.metadataJson as Prisma.InputJsonValue | undefined,
    },
    include: listInclude,
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateTaskInput
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  // Auto-set completedAt when status transitions to "done", unless explicitly provided
  let completedAt: Date | null | undefined = undefined;
  if (input.completedAt !== undefined) {
    completedAt = input.completedAt ? new Date(input.completedAt) : null;
  } else if (input.status === "done" && task.status !== "done") {
    completedAt = new Date();
  }

  return fastify.prisma.task.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.assignedUserId !== undefined && { assignedUserId: input.assignedUserId }),
      ...(input.dueAt !== undefined && {
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      }),
      ...(input.metadataJson !== undefined && {
        metadataJson: input.metadataJson as Prisma.InputJsonValue,
      }),
      ...(completedAt !== undefined && { completedAt }),
    },
    include: listInclude,
  });
}

export async function complete(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  return fastify.prisma.task.update({
    where: { id },
    data: {
      status: "done",
      completedAt: new Date(),
    },
    include: listInclude,
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const task = await fastify.prisma.task.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!task) throw fastify.httpErrors.notFound("Task not found");

  return fastify.prisma.task.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}
