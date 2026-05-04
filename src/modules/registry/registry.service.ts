import type { FastifyInstance } from "fastify";
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  CreateSeriesInput,
  UpdateSeriesInput,
  CreateEntryInput,
  UpdateEntryInput,
  VoidEntryInput,
} from "./registry.schema.js";

const entryInclude = {
  series: { select: { id: true, code: true, name: true, prefix: true, direction: true } },
  document: { select: { id: true, name: true, status: true } },
  project: { select: { id: true, name: true } },
  client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
  voidedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

// ─── Series ─────────────────────────────────────────────────────────────

const DEFAULT_SERIES = [
  { code: "intrari", name: "Registru intrări", direction: "IN", prefix: "IN", sortOrder: 1 },
  { code: "iesiri", name: "Registru ieșiri", direction: "OUT", prefix: "OUT", sortOrder: 2 },
  { code: "interne", name: "Documente interne", direction: "INTERNAL", prefix: null, sortOrder: 3 },
];

export async function ensureDefaultSeries(fastify: FastifyInstance, tenantId: string) {
  const count = await fastify.prisma.registrySeries.count({ where: { tenantId } });
  if (count > 0) return;
  await fastify.prisma.registrySeries.createMany({
    data: DEFAULT_SERIES.map((s) => ({ ...s, tenantId })),
    skipDuplicates: true,
  });
}

export async function listSeries(fastify: FastifyInstance, tenantId: string) {
  await ensureDefaultSeries(fastify, tenantId);
  return fastify.prisma.registrySeries.findMany({
    where: { tenantId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function createSeries(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateSeriesInput
) {
  return fastify.prisma.registrySeries.create({
    data: { tenantId, ...input },
  });
}

export async function updateSeries(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateSeriesInput
) {
  const series = await fastify.prisma.registrySeries.findFirst({ where: { id, tenantId } });
  if (!series) throw fastify.httpErrors.notFound("Series not found");

  // startingNumber can only be changed if no entries exist for the current year
  if (input.startingNumber !== undefined && input.startingNumber !== series.startingNumber) {
    const currentYear = new Date().getFullYear();
    const existingCount = await fastify.prisma.registryEntry.count({
      where: { tenantId, seriesId: id, year: currentYear },
    });
    if (existingCount > 0) {
      throw fastify.httpErrors.badRequest(
        `Nu poți modifica numărul de start — există deja ${existingCount} înregistrări pe anul ${currentYear}.`
      );
    }
  }

  return fastify.prisma.registrySeries.update({ where: { id }, data: input });
}

export async function deleteSeries(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const series = await fastify.prisma.registrySeries.findFirst({ where: { id, tenantId } });
  if (!series) throw fastify.httpErrors.notFound("Series not found");

  const entryCount = await fastify.prisma.registryEntry.count({ where: { seriesId: id } });
  if (entryCount > 0) {
    // Soft delete — deactivate instead
    return fastify.prisma.registrySeries.update({
      where: { id },
      data: { isActive: false },
    });
  }
  return fastify.prisma.registrySeries.delete({ where: { id } });
}

// ─── Entries ────────────────────────────────────────────────────────────

/**
 * Allocate next sequential number for (tenant, series, year).
 * Respects the series `startingNumber` for the first entry of a year.
 */
export async function allocateNextNumber(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  seriesId: string,
  year: number
): Promise<number> {
  const last = await prisma.registryEntry.findFirst({
    where: { tenantId, seriesId, year },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  if (last) return last.number + 1;

  // First entry for this year — use series startingNumber
  const series = await prisma.registrySeries.findUnique({
    where: { id: seriesId },
    select: { startingNumber: true },
  });
  return series?.startingNumber ?? 1;
}

function buildDisplayNumber(prefix: string | null, number: number, year: number): string {
  const p = prefix ? `${prefix}-` : "";
  return `${p}${number}/${year}`;
}

export async function listEntries(
  fastify: FastifyInstance,
  tenantId: string,
  filters: {
    seriesId?: string;
    year?: number;
    search?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }
) {
  const where: Prisma.RegistryEntryWhereInput = {
    tenantId,
    ...(filters.seriesId && { seriesId: filters.seriesId }),
    ...(filters.year && { year: filters.year }),
    ...(filters.status && { status: filters.status }),
    ...(filters.search && {
      OR: [
        { subject: { contains: filters.search, mode: "insensitive" } },
        { counterpartName: { contains: filters.search, mode: "insensitive" } },
        { displayNumber: { contains: filters.search, mode: "insensitive" } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.registryEntry.findMany({
      where,
      include: entryInclude,
      orderBy: [{ year: "desc" }, { number: "desc" }],
      take: filters.limit ?? 50,
      skip: filters.offset ?? 0,
    }),
    fastify.prisma.registryEntry.count({ where }),
  ]);
  return { data, total };
}

export async function getEntryById(fastify: FastifyInstance, tenantId: string, id: string) {
  const entry = await fastify.prisma.registryEntry.findFirst({
    where: { id, tenantId },
    include: entryInclude,
  });
  if (!entry) throw fastify.httpErrors.notFound("Entry not found");
  return entry;
}

export async function getNextNumberPreview(
  fastify: FastifyInstance,
  tenantId: string,
  seriesId: string
) {
  const series = await fastify.prisma.registrySeries.findFirst({
    where: { id: seriesId, tenantId, isActive: true },
  });
  if (!series) throw fastify.httpErrors.notFound("Series not found");
  const year = new Date().getFullYear();
  const nextNumber = await allocateNextNumber(fastify.prisma, tenantId, seriesId, year);
  return {
    number: nextNumber,
    year,
    displayNumber: buildDisplayNumber(series.prefix, nextNumber, year),
  };
}

export async function createEntry(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: CreateEntryInput,
  isAdmin: boolean
) {
  // Reject manual override for non-admins
  if (input.manualNumber && !isAdmin) {
    throw fastify.httpErrors.forbidden("Only ADMIN can set manual number");
  }

  const series = await fastify.prisma.registrySeries.findFirst({
    where: { id: input.seriesId, tenantId, isActive: true },
  });
  if (!series) throw fastify.httpErrors.notFound("Series not found or inactive");

  const year = new Date().getFullYear();

  // Retry loop: @@unique constraint may conflict under concurrent requests
  const maxAttempts = input.manualNumber ? 1 : 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const number =
        input.manualNumber ??
        (await allocateNextNumber(fastify.prisma, tenantId, series.id, year));
      const displayNumber = buildDisplayNumber(series.prefix, number, year);

      return await fastify.prisma.registryEntry.create({
        data: {
          tenantId,
          seriesId: series.id,
          year,
          number,
          displayNumber,
          subject: input.subject,
          description: input.description,
          counterpartName: input.counterpartName,
          fileS3Key: input.fileS3Key,
          documentId: input.documentId,
          projectId: input.projectId,
          clientId: input.clientId,
          createdById: userId,
          isManualOverride: !!input.manualNumber,
          overrideReason: input.overrideReason,
        },
        include: entryInclude,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        if (input.manualNumber) {
          throw fastify.httpErrors.conflict(
            `Numărul ${input.manualNumber}/${year} există deja în această serie.`
          );
        }
        // Race condition, retry with fresh next number
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to allocate registry number after 5 attempts");
}

/**
 * Worker-side: allocate a registry entry for an automatically-generated document.
 * Used inside document-generation worker BEFORE rendering PDF so the number
 * can be embedded in the output.
 */
export async function allocateEntryForDocument(
  prisma: PrismaClient,
  tenantId: string,
  userId: string | null,
  seriesCode: string,
  subject: string,
  documentId?: string,
  projectId?: string | null,
  clientId?: string | null
) {
  const series = await prisma.registrySeries.findFirst({
    where: { tenantId, code: seriesCode, isActive: true },
  });
  if (!series) return null;

  const year = new Date().getFullYear();

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const number = await allocateNextNumber(prisma, tenantId, series.id, year);
      const displayNumber = buildDisplayNumber(series.prefix, number, year);

      return await prisma.registryEntry.create({
        data: {
          tenantId,
          seriesId: series.id,
          year,
          number,
          displayNumber,
          subject,
          documentId,
          projectId: projectId ?? null,
          clientId: clientId ?? null,
          createdById: userId ?? (await getSystemUserId(prisma, tenantId)),
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function getSystemUserId(prisma: PrismaClient, tenantId: string): Promise<string> {
  // Fallback: find first admin of tenant to attribute auto-generated entries
  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN" },
    select: { id: true },
  });
  if (admin) return admin.id;
  const any = await prisma.user.findFirst({ where: { tenantId }, select: { id: true } });
  if (!any) throw new Error(`No user found for tenant ${tenantId}`);
  return any.id;
}

export async function updateEntry(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateEntryInput
) {
  const entry = await fastify.prisma.registryEntry.findFirst({ where: { id, tenantId } });
  if (!entry) throw fastify.httpErrors.notFound("Entry not found");
  if (entry.status === "voided") {
    throw fastify.httpErrors.badRequest("Cannot edit a voided entry");
  }
  return fastify.prisma.registryEntry.update({
    where: { id },
    data: input,
    include: entryInclude,
  });
}

export async function voidEntry(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  id: string,
  input: VoidEntryInput
) {
  const entry = await fastify.prisma.registryEntry.findFirst({ where: { id, tenantId } });
  if (!entry) throw fastify.httpErrors.notFound("Entry not found");
  if (entry.status === "voided") {
    throw fastify.httpErrors.badRequest("Entry is already voided");
  }
  return fastify.prisma.registryEntry.update({
    where: { id },
    data: {
      status: "voided",
      voidedAt: new Date(),
      voidedById: userId,
      voidReason: input.voidReason,
    },
    include: entryInclude,
  });
}
