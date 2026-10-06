import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { PaginationQuery } from "../../lib/pagination.js";
import { paginationArgs, paginationMeta } from "../../lib/pagination.js";
import type {
  CreateClientInput,
  UpdateClientInput,
  GasInstallationInput,
  QuickDossierInput,
  UpdateQuickDossierInput,
} from "./clients.schema.js";
import { generate as documentsGenerate } from "../documents/documents.service.js";

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

/** KPI counts for the Clienți page header. */
export async function stats(fastify: FastifyInstance, tenantId: string) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [total, active, prospect, inactive, companies, persons, addedThisMonth, localities] =
    await Promise.all([
      fastify.prisma.client.count({ where: { tenantId } }),
      fastify.prisma.client.count({ where: { tenantId, status: "ACTIVE" } }),
      fastify.prisma.client.count({ where: { tenantId, status: "PROSPECT" } }),
      fastify.prisma.client.count({ where: { tenantId, status: "INACTIVE" } }),
      fastify.prisma.client.count({ where: { tenantId, type: "COMPANY" } }),
      fastify.prisma.client.count({ where: { tenantId, type: "PERSON" } }),
      fastify.prisma.client.count({ where: { tenantId, createdAt: { gte: startOfMonth } } }),
      fastify.prisma.clientAddress.findMany({
        where: { client: { tenantId }, cityId: { not: null } },
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

/**
 * Map template-group category → projectType code. Lets us back the hidden
 * quick-dossier Project with the same projectType the equivalent full project
 * would use, so any code that already keys behavior off projectType keeps
 * working without special-casing kind="quick_dossier".
 */
const CATEGORY_TO_PROJECT_TYPE_CODE: Record<string, string> = {
  CARTE_BRANSAMENT: "bransament",
  CARTE_CONDUCTA: "conducta",
  DOSAR_ISCIR: "dosar_iscir",
};

const dossierInclude = {
  templateGroup: { select: { id: true, name: true, categoryCode: true } },
  teamMembers: {
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, position: true } },
    },
  },
  projectType: { select: { id: true, code: true, name: true } },
} as const;

export async function listDossiers(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string
) {
  await getById(fastify, tenantId, clientId);
  return fastify.prisma.project.findMany({
    where: { tenantId, clientId, kind: "quick_dossier" },
    include: dossierInclude,
    orderBy: { createdAt: "desc" as const },
  });
}

export async function createDossier(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  clientId: string,
  input: QuickDossierInput
) {
  const client = await getById(fastify, tenantId, clientId);

  // Resolve template group (must be a global or tenant-owned group).
  const group = await fastify.prisma.documentTemplate.findFirst({
    where: {
      id: input.templateGroupId,
      type: "group",
      isActive: true,
      OR: [{ tenantId }, { tenantId: null }],
    },
  });
  if (!group) throw fastify.httpErrors.notFound("Template group not found");

  // Resolve the projectType that matches the template category. This keeps
  // the underlying Project compatible with whatever project-type-driven logic
  // exists elsewhere (e.g. registry series picker, workflow defaults).
  const ptCode = CATEGORY_TO_PROJECT_TYPE_CODE[group.categoryCode];
  if (!ptCode) {
    throw fastify.httpErrors.badRequest(
      `No projectType mapping for category ${group.categoryCode} — quick-dossier only supports CARTE_BRANSAMENT, CARTE_CONDUCTA, DOSAR_ISCIR.`,
    );
  }
  const projectType = await fastify.prisma.projectType.findFirst({
    where: { tenantId, code: ptCode },
  });
  if (!projectType) {
    throw fastify.httpErrors.failedDependency(
      `ProjectType "${ptCode}" not seeded for this tenant — run prisma seed.`,
    );
  }

  const clientLabel = client.type === "COMPANY"
    ? client.companyName ?? ""
    : `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim();
  const defaultName = `${group.name} — ${clientLabel || clientId.slice(-6)}`;

  // Validate any provided employee IDs belong to this tenant before insert,
  // so a 404 surfaces immediately instead of a confusing FK error mid-create.
  const teamMembers = input.teamMembers ?? [];
  if (teamMembers.length > 0) {
    const empIds = teamMembers.filter((tm) => tm.employeeId).map((tm) => tm.employeeId!);
    if (empIds.length > 0) {
      const found = await fastify.prisma.employee.count({
        where: { tenantId, id: { in: empIds } },
      });
      if (found !== empIds.length) {
        throw fastify.httpErrors.badRequest("One or more team-member employees not found");
      }
    }
  }

  // Single create — Project + nested ProjectTeamMember rows together.
  return fastify.prisma.project.create({
    data: {
      tenantId,
      clientId,
      projectTypeId: projectType.id,
      kind: "quick_dossier",
      templateGroupId: group.id,
      name: input.name ?? defaultName,
      address: input.address,
      city: input.city,
      county: input.county,
      status: "draft",
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      teamMembers: teamMembers.length > 0
        ? {
            create: teamMembers.map((tm) => ({
              role: tm.role,
              name: "", // legacy column — filled at render time from employee
              employeeId: tm.employeeId ?? null,
              credentials: (tm.credentials ?? {}) as Prisma.InputJsonValue,
            })),
          }
        : undefined,
    },
    include: dossierInclude,
  });
}

export async function updateDossier(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  dossierId: string,
  input: UpdateQuickDossierInput
) {
  await getById(fastify, tenantId, clientId);
  const dossier = await fastify.prisma.project.findFirst({
    where: { id: dossierId, tenantId, clientId, kind: "quick_dossier" },
  });
  if (!dossier) throw fastify.httpErrors.notFound("Dossier not found");

  // Team-member updates use replace-all: delete + recreate. Simpler than
  // computing a diff and acceptable because team is small (<10 rows typically).
  if (input.teamMembers !== undefined) {
    await fastify.prisma.projectTeamMember.deleteMany({ where: { projectId: dossierId } });
  }

  return fastify.prisma.project.update({
    where: { id: dossierId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.address !== undefined && { address: input.address }),
      ...(input.city !== undefined && { city: input.city }),
      ...(input.county !== undefined && { county: input.county }),
      ...(input.metadata !== undefined && { metadata: input.metadata as Prisma.InputJsonValue }),
      ...(input.templateGroupId !== undefined && { templateGroupId: input.templateGroupId }),
      ...(input.teamMembers !== undefined && input.teamMembers.length > 0 && {
        teamMembers: {
          create: input.teamMembers.map((tm) => ({
            role: tm.role,
            name: "",
            employeeId: tm.employeeId ?? null,
            credentials: (tm.credentials ?? {}) as Prisma.InputJsonValue,
          })),
        },
      }),
    },
    include: dossierInclude,
  });
}

export async function generateDossier(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  clientId: string,
  dossierId: string
) {
  await getById(fastify, tenantId, clientId);
  const dossier = await fastify.prisma.project.findFirst({
    where: { id: dossierId, tenantId, clientId, kind: "quick_dossier" },
    select: { id: true, templateGroupId: true },
  });
  if (!dossier) throw fastify.httpErrors.notFound("Dossier not found");
  if (!dossier.templateGroupId) {
    throw fastify.httpErrors.badRequest("Dossier has no template group assigned");
  }

  // Generate the ONE template group as a single ZIP — the worker handles
  // group expansion + per-member registry numbers + image embedding. Calling
  // generate() with the group's templateId (not its member IDs) is the right
  // path because the worker checks template.type==="group" and renders accordingly.
  return documentsGenerate(fastify, tenantId, dossier.id, [dossier.templateGroupId], userId);
}

export async function removeDossier(
  fastify: FastifyInstance,
  tenantId: string,
  clientId: string,
  dossierId: string
) {
  await getById(fastify, tenantId, clientId);
  const dossier = await fastify.prisma.project.findFirst({
    where: { id: dossierId, tenantId, clientId, kind: "quick_dossier" },
  });
  if (!dossier) throw fastify.httpErrors.notFound("Dossier not found");
  // Hard delete — cascade removes ProjectTeamMember + ProjectDocument joins.
  // Documents themselves stay (they may have been downloaded/shared); they
  // become orphan but still accessible via /api/documents/:id/download.
  await fastify.prisma.project.delete({ where: { id: dossierId } });
  return { success: true };
}

// === Helpers ===

function ensurePrimary<T extends { isPrimary?: boolean }>(addresses: T[]): T[] {
  const hasPrimary = addresses.some((a) => a.isPrimary);
  if (!hasPrimary && addresses.length > 0) {
    addresses[0] = { ...addresses[0], isPrimary: true };
  }
  return addresses;
}
