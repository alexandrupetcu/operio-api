import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateClientInput, UpdateClientInput } from "./clients.schema.js";

const addressInclude = {
  country: { select: { id: true, name: true, emoji: true } },
  state: { select: { id: true, name: true } },
  city: { select: { id: true, name: true } },
} as const;

const clientInclude = {
  contactPersons: true,
  equipment: {
    include: {
      clientAddress: { select: { id: true, label: true, address: true } },
      revisions: {
        orderBy: { revisionDate: "desc" as const },
        take: 1,
        select: { id: true, revisionDate: true, operatorName: true },
      },
    },
  },
  addresses: {
    include: addressInclude,
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] as any,
  },
};

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
        { addresses: { some: { city: { name: { contains: query.search, mode: "insensitive" as const } } } } },
        { addresses: { some: { state: { name: { contains: query.search, mode: "insensitive" as const } } } } },
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
    include: {
      ...clientInclude,
      projects: {
        include: { projectType: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");
  return client;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateClientInput
) {
  const { contactPersons, equipment, addresses, ...clientData } = input.type === "COMPANY"
    ? input
    : { ...input, contactPersons: undefined };

  // Ensure exactly one primary address
  const addressesWithPrimary = ensurePrimary(addresses);

  return fastify.prisma.client.create({
    data: {
      tenantId,
      ...clientData,
      ...(contactPersons?.length && {
        contactPersons: {
          create: contactPersons.map(({ id: _id, ...cp }) => cp),
        },
      }),
      addresses: {
        create: addressesWithPrimary.map(({ id: _id, ...addr }) => addr),
      },
      ...(equipment?.length && {
        equipment: {
          create: equipment.map(({ id: _id, clientAddressId: _aid, ...eq }) => ({
            type: eq.type ?? "CENTRALA",
            internalName: eq.internalName,
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

  const { contactPersons, equipment, addresses, ...clientData } = input.type === "COMPANY"
    ? input
    : { ...input, contactPersons: undefined };

  return fastify.prisma.$transaction(async (tx) => {
    if (input.type === "COMPANY" && contactPersons) {
      const keepIds = contactPersons
        .filter((cp) => cp.id)
        .map((cp) => cp.id as string);

      await tx.contactPerson.deleteMany({
        where: { clientId: id, id: { notIn: keepIds } },
      });

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

    // Handle addresses
    if (addresses) {
      const addressesWithPrimary = ensurePrimary(addresses);
      const keepIds = addressesWithPrimary
        .filter((a) => a.id)
        .map((a) => a.id as string);

      await tx.clientAddress.deleteMany({
        where: { clientId: id, id: { notIn: keepIds } },
      });

      for (const addr of addressesWithPrimary) {
        const { id: addrId, ...data } = addr;
        if (addrId) {
          await tx.clientAddress.update({
            where: { id: addrId },
            data,
          });
        } else {
          await tx.clientAddress.create({
            data: { clientId: id, ...data },
          });
        }
      }
    }

    // Handle equipment
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
            data: {
              type: eq.type ?? "CENTRALA",
              internalName: eq.internalName,
              fuel: eq.fuel,
              serial: eq.serial,
              clientAddressId: eq.clientAddressId ?? null,
            },
          });
        } else {
          await tx.equipment.create({
            data: {
              clientId: id,
              type: eq.type ?? "CENTRALA",
              internalName: eq.internalName,
              fuel: eq.fuel,
              serial: eq.serial,
              clientAddressId: eq.clientAddressId ?? null,
            },
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

// === Address standalone CRUD ===

export async function addAddress(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  input: { label?: string; address: string; countryId?: number | null; stateId?: number | null; cityId?: number | null; isPrimary?: boolean }
) {
  await getById(fastify, tenantId, clientId);

  if (input.isPrimary) {
    await fastify.prisma.clientAddress.updateMany({
      where: { clientId, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  return fastify.prisma.clientAddress.create({
    data: {
      clientId,
      label: input.label,
      address: input.address,
      countryId: input.countryId ?? null,
      stateId: input.stateId ?? null,
      cityId: input.cityId ?? null,
      isPrimary: input.isPrimary ?? false,
    },
    include: addressInclude,
  });
}

export async function updateAddress(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  addressId: string,
  input: { label?: string; address?: string; countryId?: number | null; stateId?: number | null; cityId?: number | null; isPrimary?: boolean }
) {
  await getById(fastify, tenantId, clientId);
  const addr = await fastify.prisma.clientAddress.findFirst({
    where: { id: addressId, clientId },
  });
  if (!addr) throw fastify.httpErrors.notFound("Address not found");

  if (input.isPrimary) {
    await fastify.prisma.clientAddress.updateMany({
      where: { clientId, isPrimary: true, id: { not: addressId } },
      data: { isPrimary: false },
    });
  }

  return fastify.prisma.clientAddress.update({
    where: { id: addressId },
    data: {
      ...(input.label !== undefined && { label: input.label }),
      ...(input.address !== undefined && { address: input.address }),
      ...(input.countryId !== undefined && { countryId: input.countryId }),
      ...(input.stateId !== undefined && { stateId: input.stateId }),
      ...(input.cityId !== undefined && { cityId: input.cityId }),
      ...(input.isPrimary !== undefined && { isPrimary: input.isPrimary }),
    },
    include: addressInclude,
  });
}

export async function removeAddress(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  addressId: string
) {
  await getById(fastify, tenantId, clientId);
  const addr = await fastify.prisma.clientAddress.findFirst({
    where: { id: addressId, clientId },
  });
  if (!addr) throw fastify.httpErrors.notFound("Address not found");

  // Prevent deleting the last address
  const count = await fastify.prisma.clientAddress.count({ where: { clientId } });
  if (count <= 1) throw fastify.httpErrors.badRequest("Cannot delete the last address");

  await fastify.prisma.clientAddress.delete({ where: { id: addressId } });

  // If deleted was primary, promote the first remaining one
  if (addr.isPrimary) {
    const first = await fastify.prisma.clientAddress.findFirst({
      where: { clientId },
      orderBy: { createdAt: "asc" },
    });
    if (first) {
      await fastify.prisma.clientAddress.update({
        where: { id: first.id },
        data: { isPrimary: true },
      });
    }
  }

  return { success: true };
}

// === Equipment standalone CRUD ===

export async function addEquipment(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  input: { type?: string; internalName: string; fuel?: string; serial?: string; clientAddressId?: string | null }
) {
  await getById(fastify, tenantId, clientId);
  return fastify.prisma.equipment.create({
    data: {
      clientId,
      type: (input.type as any) ?? "CENTRALA",
      internalName: input.internalName,
      fuel: input.fuel,
      serial: input.serial,
      clientAddressId: input.clientAddressId ?? null,
    },
    include: {
      clientAddress: { select: { id: true, label: true, address: true } },
    },
  });
}

export async function updateEquipment(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string,
  input: { type?: string; internalName?: string; fuel?: string; serial?: string; clientAddressId?: string | null }
) {
  await getById(fastify, tenantId, clientId);
  const eq = await fastify.prisma.equipment.findFirst({
    where: { id: equipmentId, clientId },
  });
  if (!eq) throw fastify.httpErrors.notFound("Equipment not found");
  return fastify.prisma.equipment.update({
    where: { id: equipmentId },
    data: {
      ...(input.type && { type: input.type as any }),
      ...(input.internalName && { internalName: input.internalName }),
      ...(input.fuel !== undefined && { fuel: input.fuel }),
      ...(input.serial !== undefined && { serial: input.serial }),
      ...(input.clientAddressId !== undefined && { clientAddressId: input.clientAddressId }),
    },
    include: {
      clientAddress: { select: { id: true, label: true, address: true } },
    },
  });
}

export async function removeEquipment(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  equipmentId: string
) {
  await getById(fastify, tenantId, clientId);
  const eq = await fastify.prisma.equipment.findFirst({
    where: { id: equipmentId, clientId },
  });
  if (!eq) throw fastify.httpErrors.notFound("Equipment not found");
  return fastify.prisma.equipment.delete({ where: { id: equipmentId } });
}

// === Helpers ===

function ensurePrimary<T extends { isPrimary?: boolean }>(addresses: T[]): T[] {
  const hasPrimary = addresses.some((a) => a.isPrimary);
  if (!hasPrimary && addresses.length > 0) {
    addresses[0] = { ...addresses[0], isPrimary: true };
  }
  return addresses;
}
