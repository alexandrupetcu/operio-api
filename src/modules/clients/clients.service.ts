import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import { assertAddressOfClient } from "../../lib/tenant-guard.js";
import type {
  CreateClientInput,
  UpdateClientInput,
  GasInstallationInput,
  QuickDossierInput,
  UpdateQuickDossierInput,
} from "./clients.schema.js";
import * as dossiersService from "../dossiers/dossiers.service.js";
import { getSampleClientId } from "../tenant/sample-settings.js";

/** Columns the client list may be sorted by (allowlist for `sortBy`). */
export const CLIENTS_SORTABLE = [
  "companyName",
  "lastName",
  "firstName",
  "status",
  "createdAt",
  "updatedAt",
] as const;

const addressInclude = {
  country: { select: { id: true, name: true, emoji: true } },
  state: { select: { id: true, name: true } },
  city: { select: { id: true, name: true } },
} as const;

const installationAppointmentSelect = {
  id: true,
  type: true,
  title: true,
  date: true,
  status: true,
  completionDataJson: true,
  completedAt: true,
  // Depunerea / înregistrarea fișei la operatorul de sistem (OsStatus în fișa clientului).
  osSubmittedAt: true,
  osRegistrationNumber: true,
  osRegisteredAt: true,
  osClientNotifiedAt: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
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
  gasInstallations: {
    include: {
      clientAddress: { include: addressInclude },
      appointments: {
        where: { deletedAt: null },
        orderBy: { date: "desc" as const },
        select: installationAppointmentSelect,
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
  addresses: {
    include: addressInclude,
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] as any,
  },
  _count: { select: { projects: true } },
};

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: PaginationQuery & { status?: string; type?: string }
) {
  const where = {
    tenantId,
    ...(query.status && { status: query.status as any }),
    ...(query.type && { type: query.type as any }),
    ...(query.search && {
      OR: [
        { companyName: { contains: query.search, mode: "insensitive" as const } },
        { firstName: { contains: query.search, mode: "insensitive" as const } },
        { lastName: { contains: query.search, mode: "insensitive" as const } },
        { phone: { contains: query.search, mode: "insensitive" as const } },
        { email: { contains: query.search, mode: "insensitive" as const } },
        { cui: { contains: query.search, mode: "insensitive" as const } },
        { addresses: { some: { address: { contains: query.search, mode: "insensitive" as const } } } },
        { addresses: { some: { city: { name: { contains: query.search, mode: "insensitive" as const } } } } },
        { addresses: { some: { state: { name: { contains: query.search, mode: "insensitive" as const } } } } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.client.findMany({
      where,
      include: clientInclude,
      ...paginationArgs(query, CLIENTS_SORTABLE),
    }),
    fastify.prisma.client.count({ where }),
  ]);

  return { data, ...paginationMeta(total, query) };
}

/** KPI counts for the Clienți page header. */
export async function stats(fastify: FastifyInstance, tenantId: string) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // Clientul de exemplu (onboarding) rămâne în listă, dar nu umflă KPI-urile.
  const sampleClientId = await getSampleClientId(fastify.prisma, tenantId);
  const base = { tenantId, ...(sampleClientId && { id: { not: sampleClientId } }) };

  const [total, active, prospect, inactive, companies, persons, addedThisMonth, localities] =
    await Promise.all([
      fastify.prisma.client.count({ where: base }),
      fastify.prisma.client.count({ where: { ...base, status: "ACTIVE" } }),
      fastify.prisma.client.count({ where: { ...base, status: "PROSPECT" } }),
      fastify.prisma.client.count({ where: { ...base, status: "INACTIVE" } }),
      fastify.prisma.client.count({ where: { ...base, type: "COMPANY" } }),
      fastify.prisma.client.count({ where: { ...base, type: "PERSON" } }),
      fastify.prisma.client.count({ where: { ...base, createdAt: { gte: startOfMonth } } }),
      fastify.prisma.clientAddress.findMany({
        where: { client: base, cityId: { not: null } },
        select: { cityId: true },
        distinct: ["cityId"],
      }),
    ]);
  return {
    total,
    active,
    prospect,
    inactive,
    companies,
    persons,
    addedThisMonth,
    localities: localities.length,
  };
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
        take: 500,
      },
    },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");
  return client;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateClientInput,
  idempotencyKey: string | null = null
) {
  const { contactPersons, equipment, addresses, ...clientData } = input.type === "COMPANY"
    ? input
    : { ...input, contactPersons: undefined };

  // Clientul adăugat fără semnal e retrimis de telefon cu aceeași cheie: întoarcem
  // rândul deja creat în loc să facem un dublu (cheia e unică pe firmă).
  const existing = idempotencyKey ? await findByIdempotencyKey(fastify, tenantId, idempotencyKey) : null;
  if (existing) return existing;

  // Ensure exactly one primary address
  const addressesWithPrimary = ensurePrimary(addresses);

  try {
    return await createRow();
  } catch (err) {
    // Două retrimiteri în paralel: a doua pierde unicul și citește rândul primei.
    if (idempotencyKey && isUniqueViolation(err)) {
      const raced = await findByIdempotencyKey(fastify, tenantId, idempotencyKey);
      if (raced) return raced;
    }
    throw err;
  }

  function createRow() {
  return fastify.prisma.client.create({
    data: {
      tenantId,
      createIdempotencyKey: idempotencyKey,
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
}

function findByIdempotencyKey(fastify: FastifyInstance, tenantId: string, key: string) {
  return fastify.prisma.client.findFirst({ where: { tenantId, createIdempotencyKey: key }, include: clientInclude });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
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
          // updateMany cu clientId în where: un id străin nu atinge rândul altui client
          const res = await tx.contactPerson.updateMany({
            where: { id: cp.id, clientId: id },
            data: { firstName: cp.firstName, lastName: cp.lastName, phone: cp.phone, email: cp.email },
          });
          if (res.count === 0) {
            throw fastify.httpErrors.badRequest("Persoana de contact nu aparține clientului");
          }
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
          const res = await tx.clientAddress.updateMany({
            where: { id: addrId, clientId: id },
            data,
          });
          if (res.count === 0) {
            throw fastify.httpErrors.badRequest("Adresa nu aparține clientului");
          }
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

      // Adresele valide se citesc o singură dată, DUPĂ ce blocul de adrese de mai
      // sus a creat/șters — altfel o adresă nouă din același payload ar fi respinsă.
      const ownAddressIds = new Set(
        (await tx.clientAddress.findMany({ where: { clientId: id }, select: { id: true } })).map((a) => a.id)
      );
      for (const eq of equipment) {
        if (eq.clientAddressId && !ownAddressIds.has(eq.clientAddressId)) {
          throw fastify.httpErrors.badRequest("Adresa echipamentului nu aparține clientului");
        }
      }

      for (const eq of equipment) {
        if (eq.id) {
          const res = await tx.equipment.updateMany({
            where: { id: eq.id, clientId: id },
            data: {
              type: eq.type ?? "CENTRALA",
              internalName: eq.internalName,
              fuel: eq.fuel,
              serial: eq.serial,
              clientAddressId: eq.clientAddressId ?? null,
            },
          });
          if (res.count === 0) {
            throw fastify.httpErrors.badRequest("Echipamentul nu aparține clientului");
          }
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
  input: EquipmentInput & { internalName: string }
) {
  await getById(fastify, tenantId, clientId);
  await assertAddressOfClient(fastify, clientId, input.clientAddressId);
  return fastify.prisma.equipment.create({
    data: {
      clientId,
      type: (input.type as any) ?? "CENTRALA",
      internalName: input.internalName,
      fuel: input.fuel,
      serial: input.serial,
      clientAddressId: input.clientAddressId ?? null,
      ...pickTechnical(input),
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
  input: EquipmentInput
) {
  await getById(fastify, tenantId, clientId);
  const eq = await fastify.prisma.equipment.findFirst({
    where: { id: equipmentId, clientId },
  });
  if (!eq) throw fastify.httpErrors.notFound("Equipment not found");
  await assertAddressOfClient(fastify, clientId, input.clientAddressId);
  return fastify.prisma.equipment.update({
    where: { id: equipmentId },
    data: {
      ...(input.type && { type: input.type as any }),
      ...(input.internalName && { internalName: input.internalName }),
      ...(input.fuel !== undefined && { fuel: input.fuel }),
      ...(input.serial !== undefined && { serial: input.serial }),
      ...(input.clientAddressId !== undefined && { clientAddressId: input.clientAddressId }),
      ...pickTechnical(input),
    },
    include: {
      clientAddress: { select: { id: true, label: true, address: true } },
    },
  });
}

type EquipmentInput = {
  type?: string;
  internalName?: string;
  fuel?: string;
  serial?: string;
  clientAddressId?: string | null;
  deviceType?: string | null;
  power?: string | null;
  airSupply?: string | null;
  feeding?: string | null;
  location?: string | null;
  deviceAge?: string | null;
};

const TECHNICAL_FIELDS = ["deviceType", "power", "airSupply", "feeding", "location", "deviceAge"] as const;

/** Doar câmpurile tehnice trimise (undefined = neatins; null = golit). */
function pickTechnical(input: EquipmentInput) {
  const out: Partial<Record<(typeof TECHNICAL_FIELDS)[number], string | null>> = {};
  for (const k of TECHNICAL_FIELDS) if (input[k] !== undefined) out[k] = input[k];
  return out;
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

// ── Gas installations (instalații de utilizare) ─────────────────────────────

const installationInclude = {
  clientAddress: { include: addressInclude },
  appointments: {
    where: { deletedAt: null },
    orderBy: { date: "desc" as const },
    select: installationAppointmentSelect,
  },
} as const;

export async function listInstallations(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string
) {
  await getById(fastify, tenantId, clientId);
  return fastify.prisma.gasInstallation.findMany({
    where: { clientId },
    include: installationInclude,
    orderBy: { createdAt: "asc" },
    take: 200,
  });
}

export async function addInstallation(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  input: GasInstallationInput
) {
  await getById(fastify, tenantId, clientId);
  const { appliances, ...rest } = input;
  return fastify.prisma.gasInstallation.create({
    data: {
      clientId,
      ...rest,
      ...(appliances !== undefined && { appliancesJson: appliances as unknown as Prisma.InputJsonValue }),
    },
    include: installationInclude,
  });
}

export async function updateInstallation(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  installationId: string,
  input: Partial<GasInstallationInput>
) {
  await getById(fastify, tenantId, clientId);
  const inst = await fastify.prisma.gasInstallation.findFirst({
    where: { id: installationId, clientId },
  });
  if (!inst) throw fastify.httpErrors.notFound("Installation not found");
  const { appliances, ...rest } = input;
  return fastify.prisma.gasInstallation.update({
    where: { id: installationId },
    data: {
      ...rest,
      ...(appliances !== undefined && { appliancesJson: appliances as unknown as Prisma.InputJsonValue }),
    },
    include: installationInclude,
  });
}

// === Quick-dossier (client-level rapid generation) ===
// Rutele vechi din fișa clientului; logica e în modules/dossiers (secțiunea „Dosare”).

async function assertDossierOfClient(fastify: FastifyInstance, tenantId: string, clientId: string, dossierId: string) {
  await getById(fastify, tenantId, clientId);
  const d = await fastify.prisma.project.findFirst({
    where: { id: dossierId, tenantId, clientId, kind: "quick_dossier" },
    select: { id: true },
  });
  if (!d) throw fastify.httpErrors.notFound("Dossier not found");
}

export async function listDossiers(fastify: FastifyInstance, tenantId: string, clientId: string) {
  await getById(fastify, tenantId, clientId);
  return dossiersService.list(fastify, tenantId, { clientId });
}

export async function createDossier(
  fastify: FastifyInstance,
  tenantId: string,
  _userId: string,
  clientId: string,
  input: QuickDossierInput
) {
  await getById(fastify, tenantId, clientId);
  const d = await dossiersService.create(fastify, tenantId, {
    templateGroupId: input.templateGroupId,
    client: { id: clientId },
    name: input.name,
    address: input.address,
    city: input.city,
    county: input.county,
    metadata: stringMetadata(input.metadata),
  });
  if (input.teamMembers?.length) return dossiersService.update(fastify, tenantId, d.id, { teamMembers: input.teamMembers });
  return d;
}

export async function updateDossier(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  dossierId: string,
  input: UpdateQuickDossierInput
) {
  await assertDossierOfClient(fastify, tenantId, clientId, dossierId);
  return dossiersService.update(fastify, tenantId, dossierId, {
    templateGroupId: input.templateGroupId,
    name: input.name,
    address: input.address,
    city: input.city,
    county: input.county,
    metadata: stringMetadata(input.metadata),
    teamMembers: input.teamMembers,
  });
}

export async function generateDossier(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  clientId: string,
  dossierId: string
) {
  await assertDossierOfClient(fastify, tenantId, clientId, dossierId);
  return dossiersService.generate(fastify, tenantId, userId, dossierId);
}

export async function removeDossier(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  dossierId: string
) {
  await assertDossierOfClient(fastify, tenantId, clientId, dossierId);
  return dossiersService.remove(fastify, tenantId, dossierId);
}

function stringMetadata(meta: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!meta) return undefined;
  return Object.fromEntries(
    Object.entries(meta).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]),
  );
}

// === Helpers ===

function ensurePrimary<T extends { isPrimary?: boolean }>(addresses: T[]): T[] {
  const hasPrimary = addresses.some((a) => a.isPrimary);
  if (!hasPrimary && addresses.length > 0) {
    addresses[0] = { ...addresses[0], isPrimary: true };
  }
  return addresses;
}

/**
 * Acordul GDPR deja existent al clientului (document din categoria GDPR, finalizat sau
 * semnat) — ca wizard-ul de pe teren să nu mai ceară încă unul. `consentedAt` = data
 * celui mai vechi acord valabil, `null` dacă nu există.
 */
export async function gdprConsent(fastify: FastifyInstance, tenantId: string, clientId: string): Promise<{ consentedAt: Date | null }> {
  const client = await fastify.prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
  if (!client) throw fastify.httpErrors.notFound("Client not found");
  const doc = await fastify.prisma.document.findFirst({
    where: { tenantId, status: { in: ["COMPLETED", "SIGNED"] }, template: { categoryCode: "GDPR" }, clients: { some: { clientId } } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return { consentedAt: doc?.createdAt ?? null };
}
