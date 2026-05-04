import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import { validateStatusTransition } from "../../lib/status-workflow.js";
import type {
  CreateProjectInput,
  UpdateProjectInput,
  CreateProjectWithClientInput,
} from "./projects.schema.js";

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
  assignedEmployee: {
    select: { id: true, firstName: true, lastName: true, position: true },
  },
  documents: { orderBy: { createdAt: "desc" as const } },
} as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & { status?: string; projectTypeId?: string }
) {
  const where = {
    tenantId,
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

  return fastify.prisma.project.create({
    data: {
      tenantId,
      clientId: input.clientId,
      projectTypeId: input.projectTypeId,
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
  input: CreateProjectWithClientInput
) {
  return fastify.prisma.$transaction(async (tx) => {
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
                name: eq.name,
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

    const project = await tx.project.create({
      data: {
        tenantId,
        clientId,
        projectTypeId: input.project.projectTypeId,
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

    return project;
  });
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
