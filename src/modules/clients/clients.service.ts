import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateClientInput, UpdateClientInput } from "./clients.schema.js";

const clientInclude = {
  contactPersons: true,
  equipment: true,
  country: { select: { id: true, name: true, emoji: true } },
  state: { select: { id: true, name: true } },
  city: { select: { id: true, name: true } },
} as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & { status?: string }
) {
  const where = {
    tenantId,
    ...(query.status && { status: query.status as any }),
    ...(query.search && {
      OR: [
        { companyName: { contains: query.search, mode: "insensitive" as const } },
        { firstName: { contains: query.search, mode: "insensitive" as const } },
        { lastName: { contains: query.search, mode: "insensitive" as const } },
        { email: { contains: query.search, mode: "insensitive" as const } },
        { cui: { contains: query.search, mode: "insensitive" as const } },
        { city: { name: { contains: query.search, mode: "insensitive" as const } } },
        { state: { name: { contains: query.search, mode: "insensitive" as const } } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.client.findMany({
      where,
      include: clientInclude,
      ...paginationArgs(query),
    }),
    fastify.prisma.client.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const client = await fastify.prisma.client.findFirst({
    where: { id, tenantId },
    include: { ...clientInclude, projects: true },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");
  return client;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateClientInput
) {
  const { contactPersons, equipment, ...clientData } = input.type === "COMPANY"
    ? input
    : { ...input, contactPersons: undefined };

  return fastify.prisma.client.create({
    data: {
      tenantId,
      ...clientData,
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
    include: clientInclude,
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateClientInput
) {
  await getById(fastify, tenantId, id);

  const { contactPersons, equipment, ...clientData } = input.type === "COMPANY"
    ? input
    : { ...input, contactPersons: undefined };

  return fastify.prisma.$transaction(async (tx) => {
    if (input.type === "COMPANY" && contactPersons) {
      // Delete removed contact persons
      const keepIds = contactPersons
        .filter((cp) => cp.id)
        .map((cp) => cp.id as string);

      await tx.contactPerson.deleteMany({
        where: { clientId: id, id: { notIn: keepIds } },
      });

      // Upsert contact persons
      for (const cp of contactPersons) {
        if (cp.id) {
          await tx.contactPerson.update({
            where: { id: cp.id },
            data: { firstName: cp.firstName, lastName: cp.lastName, phone: cp.phone, email: cp.email },
          });
        } else {
          await tx.contactPerson.create({
            data: { clientId: id, firstName: cp.firstName, lastName: cp.lastName, phone: cp.phone, email: cp.email },
          });
        }
      }
    }

    // Handle equipment (for both PERSON and COMPANY)
    if (equipment) {
      const keepIds = equipment
        .filter((eq) => eq.id)
        .map((eq) => eq.id as string);

      await tx.equipment.deleteMany({
        where: { clientId: id, id: { notIn: keepIds } },
      });

      for (const eq of equipment) {
        if (eq.id) {
          await tx.equipment.update({
            where: { id: eq.id },
            data: { type: eq.type ?? "CENTRALA", name: eq.name, fuel: eq.fuel, serial: eq.serial },
          });
        } else {
          await tx.equipment.create({
            data: { clientId: id, type: eq.type ?? "CENTRALA", name: eq.name, fuel: eq.fuel, serial: eq.serial },
          });
        }
      }
    }

    return tx.client.update({
      where: { id },
      data: clientData,
      include: clientInclude,
    });
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.client.delete({ where: { id } });
}
