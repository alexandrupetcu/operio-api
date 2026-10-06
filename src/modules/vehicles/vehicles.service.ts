import type { FastifyInstance } from "fastify";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type { CreateVehicleInput, UpdateVehicleInput } from "./vehicles.routes.js";

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & { isActive?: boolean; expiry?: "expired" | "soon" }
) {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const expiryFilter =
    query.expiry === "expired"
      ? {
          OR: [
            { itpExpiry: { lt: now } },
            { insuranceExpiry: { lt: now } },
            { vignetteExpiry: { lt: now } },
          ],
        }
      : query.expiry === "soon"
        ? {
            OR: [
              { itpExpiry: { gte: now, lte: in30 } },
              { insuranceExpiry: { gte: now, lte: in30 } },
              { vignetteExpiry: { gte: now, lte: in30 } },
            ],
          }
        : undefined;

  const where = {
    tenantId,
    ...(query.isActive !== undefined && { isActive: query.isActive }),
    ...(expiryFilter ?? {}),
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
      // latest revision → current odometer ("total km")
      include: { revisions: { orderBy: { date: "desc" }, take: 1, select: { km: true, date: true } } },
      ...paginationArgs(query),
      orderBy: { licensePlate: "asc" },
    }),
    fastify.prisma.vehicle.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

/** KPI counts for the Parc Auto page header. */
export async function stats(fastify: FastifyInstance, tenantId: string) {
  const vehicles = await fastify.prisma.vehicle.findMany({
    where: { tenantId },
    select: {
      itpExpiry: true,
      insuranceExpiry: true,
      vignetteExpiry: true,
      isActive: true,
      avgKmPerMonth: true,
    },
  });

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  let active = 0;
  let inactive = 0;
  let expired = 0;
  let expiring = 0;
  let totalKmPerMonth = 0;

  for (const v of vehicles) {
    v.isActive ? active++ : inactive++;
    totalKmPerMonth += v.avgKmPerMonth ?? 0;
    const dates = [v.itpExpiry, v.insuranceExpiry, v.vignetteExpiry]
      .filter((d): d is Date => !!d)
      .map((d) => Math.floor((d.getTime() - now) / day));
    if (dates.length) {
      const minDays = Math.min(...dates);
      if (minDays < 0) expired++;
      else if (minDays <= 30) expiring++;
    }
  }

  return { total: vehicles.length, active, inactive, expired, expiring, totalKmPerMonth };
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
      itpExpiry: input.itpExpiry ? new Date(input.itpExpiry) : null,
      insuranceExpiry: input.insuranceExpiry ? new Date(input.insuranceExpiry) : null,
      vignetteExpiry: input.vignetteExpiry ? new Date(input.vignetteExpiry) : null,
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
      ...(input.itpExpiry !== undefined && {
        itpExpiry: input.itpExpiry ? new Date(input.itpExpiry) : null,
      }),
      ...(input.insuranceExpiry !== undefined && {
        insuranceExpiry: input.insuranceExpiry ? new Date(input.insuranceExpiry) : null,
      }),
      ...(input.vignetteExpiry !== undefined && {
        vignetteExpiry: input.vignetteExpiry ? new Date(input.vignetteExpiry) : null,
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
