import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateVehicleInput, UpdateVehicleInput } from "./vehicles.routes.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery
) {
  const where = {
    tenantId,
    ...(query.search && {
      OR: [
        { licensePlate: { contains: query.search, mode: "insensitive" as const } },
        { make: { contains: query.search, mode: "insensitive" as const } },
        { model: { contains: query.search, mode: "insensitive" as const } },
        { vin: { contains: query.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.vehicle.findMany({
      where,
      ...paginationArgs(query),
      orderBy: { licensePlate: "asc" },
    }),
    fastify.prisma.vehicle.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const vehicle = await fastify.prisma.vehicle.findFirst({
    where: { id, tenantId },
  });
  if (!vehicle) throw fastify.httpErrors.notFound("Vehicle not found");
  return vehicle;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateVehicleInput
) {
  return fastify.prisma.vehicle.create({
    data: {
      tenantId,
      ...input,
      insuranceExpiry: input.insuranceExpiry ? new Date(input.insuranceExpiry) : null,
      itpExpiry: input.itpExpiry ? new Date(input.itpExpiry) : null,
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateVehicleInput
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.vehicle.update({
    where: { id },
    data: {
      ...input,
      ...(input.insuranceExpiry !== undefined && {
        insuranceExpiry: input.insuranceExpiry ? new Date(input.insuranceExpiry) : null,
      }),
      ...(input.itpExpiry !== undefined && {
        itpExpiry: input.itpExpiry ? new Date(input.itpExpiry) : null,
      }),
    },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  await getById(fastify, tenantId, id);
  return fastify.prisma.vehicle.delete({ where: { id } });
}
