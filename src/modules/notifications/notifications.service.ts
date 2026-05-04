import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateNotificationInput } from "./notifications.schema.js";

const listInclude = {
  project: { select: { id: true, name: true } },
  client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
  task: { select: { id: true, title: true } },
  vehicle: { select: { id: true, licensePlate: true, make: true, model: true } },
} as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & {
    channel?: string;
    status?: string;
    userId?: string;
  }
) {
  const where: Prisma.NotificationWhereInput = {
    tenantId,
    ...(query.channel && { channel: query.channel }),
    ...(query.status && { status: query.status }),
    ...(query.userId && { userId: query.userId }),
    ...(query.category && { category: query.category }),
    ...(query.search && {
      OR: [
        { subject: { contains: query.search, mode: "insensitive" as const } },
        { body: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.notification.findMany({
      where,
      include: listInclude,
      ...paginationArgs(query),
    }),
    fastify.prisma.notification.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function listForUser(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  query: PaginationQuery & {
    status?: string;
  }
) {
  const where: Prisma.NotificationWhereInput = {
    tenantId,
    userId,
    channel: "in_app",
    ...(query.status === "unread" && { sentAt: null, status: "sent" }),
    ...(query.status === "read" && { sentAt: { not: null } }),
    ...(query.status && query.status !== "unread" && query.status !== "read" && { status: query.status }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.notification.findMany({
      where,
      include: listInclude,
      ...paginationArgs(query),
    }),
    fastify.prisma.notification.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const notification = await fastify.prisma.notification.findFirst({
    where: { id, tenantId },
    include: listInclude,
  });
  if (!notification)
    throw fastify.httpErrors.notFound("Notification not found");
  return notification;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateNotificationInput
) {
  return fastify.prisma.notification.create({
    data: {
      tenantId,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      userId: input.userId,
      clientId: input.clientId,
      projectId: input.projectId,
      taskId: input.taskId,
      workflowInstanceId: input.workflowInstanceId,
      vehicleId: input.vehicleId,
      category: input.category,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
      status: input.scheduledAt ? "scheduled" : "sent",
      metadataJson: input.metadataJson as Prisma.InputJsonValue | undefined,
    },
    include: listInclude,
  });
}

export async function markAsRead(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  ids: string[]
) {
  const result = await fastify.prisma.notification.updateMany({
    where: {
      id: { in: ids },
      tenantId,
      userId,
      sentAt: null,
    },
    data: {
      sentAt: new Date(),
    },
  });
  return { updated: result.count };
}

export async function markAllAsRead(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string
) {
  const result = await fastify.prisma.notification.updateMany({
    where: {
      tenantId,
      userId,
      channel: "in_app",
      sentAt: null,
      status: "sent",
    },
    data: {
      sentAt: new Date(),
    },
  });
  return { updated: result.count };
}

export async function getUnreadCount(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string
) {
  const count = await fastify.prisma.notification.count({
    where: {
      tenantId,
      userId,
      channel: "in_app",
      status: "sent",
      sentAt: null,
    },
  });
  return { count };
}

export async function markSent(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const notification = await fastify.prisma.notification.findFirst({
    where: { id, tenantId },
  });
  if (!notification)
    throw fastify.httpErrors.notFound("Notification not found");

  return fastify.prisma.notification.update({
    where: { id },
    data: {
      status: "sent",
      sentAt: new Date(),
    },
    include: listInclude,
  });
}

export async function markFailed(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  error?: string
) {
  const notification = await fastify.prisma.notification.findFirst({
    where: { id, tenantId },
  });
  if (!notification)
    throw fastify.httpErrors.notFound("Notification not found");

  return fastify.prisma.notification.update({
    where: { id },
    data: {
      status: "failed",
      providerResponseJson: error
        ? ({ error } as Prisma.InputJsonValue)
        : undefined,
    },
    include: listInclude,
  });
}

export async function cancel(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const notification = await fastify.prisma.notification.findFirst({
    where: { id, tenantId },
  });
  if (!notification)
    throw fastify.httpErrors.notFound("Notification not found");

  if (notification.status === "sent") {
    throw fastify.httpErrors.badRequest(
      "Cannot cancel a notification that has already been sent"
    );
  }

  return fastify.prisma.notification.update({
    where: { id },
    data: { status: "cancelled" },
    include: listInclude,
  });
}
