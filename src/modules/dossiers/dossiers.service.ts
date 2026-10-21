import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { getFileBuffer } from "../../lib/s3.js";
import {
  DOSSIER_FIELDS,
  DOSSIER_STEPS,
  dossierCompletion,
  fieldsForPlaceholders,
  placeholdersIn,
  unitFor,
  type GroupFieldPlan,
} from "../../lib/dossier-fields.js";
import { docxText } from "../tenant/stamp-text.js";
import { readCompanySettings } from "../tenant/company-settings.js";
import { ensureDefaultProjectTypes } from "../../lib/default-project-types.js";
import { generate as documentsGenerate } from "../documents/documents.service.js";
import type { CreateDossierInput, DossierTeamMemberInput, UpdateDossierInput } from "./dossiers.schema.js";

/**
 * Secțiunea „Dosare” — un `Project` ascuns (`kind="quick_dossier"`) cu grupul DOCX
 * ales (`templateGroupId`). Worker-ul îl generează ca pe orice proiect: firma,
 * clientul, `metadata`, echipa. Aici: ce câmpuri cere grupul, salvarea automată
 * (metadata combinată, echipa fără pierderea deciziilor) și completarea.
 */

/** Categoriile de grup suportate → codul tipului de proiect din spate. */
export const CATEGORY_TO_PROJECT_TYPE_CODE: Record<string, string> = {
  CARTE_BRANSAMENT: "bransament",
  CARTE_CONDUCTA: "conducta",
  DOSAR_ISCIR: "dosar_iscir",
};
const CATEGORIES = Object.keys(CATEGORY_TO_PROJECT_TYPE_CODE);

const KIND = "quick_dossier";

export const dossierInclude = {
  client: { select: { id: true, type: true, firstName: true, lastName: true, companyName: true } },
  templateGroup: { select: { id: true, name: true, categoryCode: true, distributorCode: true } },
  distributor: { select: { id: true, code: true, name: true } },
  teamMembers: {
    orderBy: { createdAt: "asc" as const },
    include: { employee: { select: { id: true, firstName: true, lastName: true, position: true } } },
  },
  documents: {
    orderBy: { createdAt: "desc" as const },
    take: 20,
    include: { document: { select: { id: true, name: true, status: true, errorMessage: true, createdAt: true } } },
  },
} satisfies Prisma.ProjectInclude;

// ── Câmpurile unui grup ─────────────────────────────────────────────────────

// Cheia S3 se schimbă la fiecare înlocuire a fișierului → rezultatul nu se învechește.
const placeholderCache = new Map<string, Set<string>>();

async function memberPlaceholders(s3Key: string, readFile: (k: string) => Promise<Buffer>): Promise<Set<string>> {
  const cached = placeholderCache.get(s3Key);
  if (cached) return cached;
  const set = placeholdersIn(docxText(await readFile(s3Key)));
  placeholderCache.set(s3Key, set);
  return set;
}

async function findGroup(fastify: FastifyInstance, tenantId: string, groupId: string) {
  const group = await fastify.prisma.documentTemplate.findFirst({
    where: { id: groupId, type: "group", isActive: true, OR: [{ tenantId }, { tenantId: null }] },
    select: {
      id: true,
      name: true,
      categoryCode: true,
      distributorCode: true,
      groupMembers: {
        where: { isActive: true },
        orderBy: { memberOrder: "asc" },
        select: { id: true, name: true, s3Key: true },
      },
    },
  });
  if (!group) throw fastify.httpErrors.notFound("Grupul de documente nu a fost găsit");
  return group;
}

export async function groupPlan(
  fastify: FastifyInstance,
  tenantId: string,
  groupId: string,
  readFile: (k: string) => Promise<Buffer> = getFileBuffer,
): Promise<GroupFieldPlan & { group: Awaited<ReturnType<typeof findGroup>> }> {
  const group = await findGroup(fastify, tenantId, groupId);
  const docs: { name: string; placeholders: Set<string> }[] = [];
  for (const m of group.groupMembers) {
    if (!m.s3Key) continue;
    try {
      docs.push({ name: m.name, placeholders: await memberPlaceholders(m.s3Key, readFile) });
    } catch (err) {
      fastify.log.warn({ err, templateId: m.id }, "dossier fields: cannot read member DOCX");
    }
  }
  return { ...fieldsForPlaceholders(docs), group };
}

/** Răspunsul pentru pagină: câmpurile grupului, cu unitatea pentru categoria lui. */
export async function getFields(fastify: FastifyInstance, tenantId: string, groupId: string) {
  const plan = await groupPlan(fastify, tenantId, groupId);
  // Distribuitorii firmei întâi, apoi lista generală (fără dubluri după nume).
  const own = await fastify.prisma.distributor.findMany({
    where: { tenantId, isActive: true },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  const optionsFor = (key: string, options: readonly string[] | undefined) => {
    if (key !== "osd_denumire") return options ? [...options] : null;
    const seen = new Set<string>();
    return [...own.map((d) => d.name), ...(options ?? [])].filter((n) => {
      const k = n.trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return {
    steps: DOSSIER_STEPS,
    fields: plan.fields.map(({ field, docs }) => ({
      key: field.key,
      label: field.label,
      help: field.help ?? null,
      step: field.step,
      section: field.section,
      type: field.type,
      unit: unitFor(field, plan.group.categoryCode) ?? null,
      options: optionsFor(field.key, field.options),
      source: field.source ?? "metadata",
      docs,
    })),
    roles: plan.roles,
    needsDrawing: plan.needsDrawing,
    usesSudoriTable: plan.usesSudoriTable,
    documents: plan.group.groupMembers.map((m) => m.name),
  };
}

/** Grupurile din care se poate face un dosar, cu distribuitorul firmei asociat. */
export async function listGroups(fastify: FastifyInstance, tenantId: string) {
  const [groups, distributors] = await Promise.all([
    fastify.prisma.documentTemplate.findMany({
      where: { type: "group", isActive: true, categoryCode: { in: CATEGORIES }, OR: [{ tenantId }, { tenantId: null }] },
      select: {
        id: true,
        name: true,
        description: true,
        categoryCode: true,
        distributorCode: true,
        tenantId: true,
        _count: { select: { groupMembers: { where: { isActive: true } } } },
      },
      orderBy: [{ categoryCode: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
    fastify.prisma.distributor.findMany({ where: { tenantId }, select: { id: true, code: true, name: true } }),
  ]);
  const byCode = new Map(distributors.map((d) => [d.code, d]));
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    categoryCode: g.categoryCode,
    distributor: g.distributorCode ? (byCode.get(g.distributorCode) ?? { id: null, code: g.distributorCode, name: g.distributorCode }) : null,
    documentCount: g._count.groupMembers,
    own: g.tenantId !== null,
  }));
}

// ── Valori și completare ────────────────────────────────────────────────────

type DossierRow = Prisma.ProjectGetPayload<{ include: typeof dossierInclude }>;

/** Valorile câmpurilor: coloanele dosarului + metadata. */
function valuesOf(d: Pick<DossierRow, "name" | "address" | "city" | "county" | "metadata">): Record<string, unknown> {
  const meta = d.metadata && typeof d.metadata === "object" && !Array.isArray(d.metadata) ? (d.metadata as Record<string, unknown>) : {};
  return { ...meta, project_name: d.name, project_address: d.address, project_city: d.city, project_county: d.county };
}

type PlanCache = Map<string, ReturnType<typeof groupPlan>>;

async function present(fastify: FastifyInstance, tenantId: string, d: DossierRow, plans: PlanCache = new Map()) {
  let completion: ReturnType<typeof dossierCompletion> | null = null;
  if (d.templateGroupId) {
    try {
      if (!plans.has(d.templateGroupId)) plans.set(d.templateGroupId, groupPlan(fastify, tenantId, d.templateGroupId));
      const plan = await plans.get(d.templateGroupId)!;
      completion = dossierCompletion(plan, valuesOf(d), new Set(d.teamMembers.filter((t) => t.employeeId).map((t) => t.role)));
    } catch {
      completion = null; // grup dezactivat între timp — dosarul rămâne vizibil
    }
  }
  const c = d.client;
  return {
    ...d,
    clientName: c.type === "COMPANY" ? (c.companyName ?? "") : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
    documents: d.documents.map((pd) => pd.document),
    completion,
  };
}

async function findDossier(fastify: FastifyInstance, tenantId: string, id: string) {
  const d = await fastify.prisma.project.findFirst({ where: { id, tenantId, kind: KIND }, include: dossierInclude });
  if (!d) throw fastify.httpErrors.notFound("Dosarul nu a fost găsit");
  return d;
}

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  query: { q?: string; clientId?: string; categoryCode?: string } = {},
) {
  const q = query.q?.trim();
  const rows = await fastify.prisma.project.findMany({
    where: {
      tenantId,
      kind: KIND,
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.categoryCode && { templateGroup: { categoryCode: query.categoryCode } }),
      ...(q && {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { address: { contains: q, mode: "insensitive" as const } },
          { client: { lastName: { contains: q, mode: "insensitive" as const } } },
          { client: { firstName: { contains: q, mode: "insensitive" as const } } },
          { client: { companyName: { contains: q, mode: "insensitive" as const } } },
        ],
      }),
    },
    include: dossierInclude,
    orderBy: { updatedAt: "desc" },
    take: 300,
  });
  const plans: PlanCache = new Map();
  return Promise.all(rows.map((r) => present(fastify, tenantId, r, plans)));
}

export async function get(fastify: FastifyInstance, tenantId: string, id: string) {
  return present(fastify, tenantId, await findDossier(fastify, tenantId, id));
}

// ── Creare / salvare ────────────────────────────────────────────────────────

/** Tipul de proiect din spatele dosarului; firmele noi îl primesc la prima nevoie. */
async function projectTypeFor(fastify: FastifyInstance, tenantId: string, code: string) {
  const find = () => fastify.prisma.projectType.findFirst({ where: { tenantId, code }, select: { id: true } });
  const found = await find();
  if (found) return found;
  await ensureDefaultProjectTypes(fastify.prisma, tenantId);
  const created = await find();
  if (!created) throw fastify.httpErrors.failedDependency(`Tipul de proiect „${code}” lipsește pentru firmă`);
  return created;
}

async function resolveDistributor(fastify: FastifyInstance, tenantId: string, code: string | null) {
  if (!code) return null;
  return fastify.prisma.distributor.findFirst({ where: { tenantId, code }, select: { id: true, name: true, contactJson: true } });
}

function clientLabel(c: { type: string; companyName: string | null; firstName: string | null; lastName: string | null }) {
  return c.type === "COMPANY" ? (c.companyName ?? "") : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
}

/** Valorile de pornire: implicitele din registru + distribuitorul (OSD). */
async function initialMetadata(fastify: FastifyInstance, tenantId: string, distributor: { name: string; contactJson: unknown } | null) {
  const meta: Record<string, string> = {};
  for (const f of DOSSIER_FIELDS) if (f.default && f.source !== "project") meta[f.key] = f.default;
  if (distributor) {
    meta.osd_denumire = distributor.name;
    const contact = distributor.contactJson as { address?: unknown } | null;
    if (contact && typeof contact.address === "string" && contact.address) meta.osd_adresa = contact.address;
  } else {
    const tenant = await fastify.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settingsJson: true } });
    const os = readCompanySettings(tenant?.settingsJson).operatorSistem;
    if (os) meta.osd_denumire = os;
  }
  return meta;
}

export async function create(fastify: FastifyInstance, tenantId: string, input: CreateDossierInput) {
  const group = await findGroup(fastify, tenantId, input.templateGroupId);
  const ptCode = CATEGORY_TO_PROJECT_TYPE_CODE[group.categoryCode];
  if (!ptCode) throw fastify.httpErrors.badRequest("Grupul ales nu e un dosar (Carte Branșament, Carte Conductă sau Dosar ISCIR)");
  const projectType = await projectTypeFor(fastify, tenantId, ptCode);
  const distributor = await resolveDistributor(fastify, tenantId, group.distributorCode);
  const defaults = await initialMetadata(fastify, tenantId, distributor);

  const id = await fastify.prisma.$transaction(async (tx) => {
    let client: { id: string; type: string; companyName: string | null; firstName: string | null; lastName: string | null; addresses: { address: string; isPrimary: boolean }[] };
    if ("id" in input.client) {
      const found = await tx.client.findFirst({
        where: { id: input.client.id, tenantId },
        select: { id: true, type: true, companyName: true, firstName: true, lastName: true, addresses: { select: { address: true, isPrimary: true } } },
      });
      if (!found) throw fastify.httpErrors.notFound("Clientul nu a fost găsit");
      client = found;
    } else {
      const { contactPersons, equipment: _eq, addresses, ...clientData } =
        input.client.type === "COMPANY" ? input.client : { ...input.client, contactPersons: undefined };
      client = await tx.client.create({
        data: {
          tenantId,
          ...clientData,
          ...(addresses?.length && {
            addresses: {
              create: addresses.map(({ id: _id, ...a }, i) => ({ ...a, isPrimary: a.isPrimary || (i === 0 && !addresses.some((x) => x.isPrimary)) })),
            },
          }),
          ...(contactPersons?.length && { contactPersons: { create: contactPersons.map(({ id: _id, ...cp }) => cp) } }),
        } as Prisma.ClientUncheckedCreateInput,
        select: { id: true, type: true, companyName: true, firstName: true, lastName: true, addresses: { select: { address: true, isPrimary: true } } },
      });
    }

    const primary = client.addresses.find((a) => a.isPrimary) ?? client.addresses[0];
    const metadata: Record<string, string> = { ...defaults };
    for (const [k, v] of Object.entries(input.metadata ?? {})) if (v !== null) metadata[k] = v;

    const p = await tx.project.create({
      data: {
        tenantId,
        clientId: client.id,
        projectTypeId: projectType.id,
        distributorId: distributor?.id ?? null,
        kind: KIND,
        templateGroupId: group.id,
        name: input.name?.trim() || `${group.name} — ${clientLabel(client) || "client"}`,
        address: input.address ?? primary?.address ?? "",
        city: input.city ?? "",
        county: input.county ?? "",
        status: "draft",
        metadata,
      },
      select: { id: true },
    });
    return p.id;
  });
  return get(fastify, tenantId, id);
}

/**
 * Echipa se potrivește după (rol, angajat): alocările existente rămân (cu deciziile
 * lor), cele noi se adaugă, cele scoase se șterg. `credentials` trimis se combină
 * peste ce era — o salvare fără el nu mai pierde nr. / data deciziei.
 */
async function syncTeam(tx: Prisma.TransactionClient, projectId: string, wanted: DossierTeamMemberInput[]) {
  const existing = await tx.projectTeamMember.findMany({ where: { projectId } });
  const keyOf = (role: string, employeeId: string | null | undefined) => `${role}:${employeeId ?? ""}`;
  const byKey = new Map(existing.map((e) => [keyOf(e.role, e.employeeId), e]));
  const kept = new Set<string>();
  for (const w of wanted) {
    const k = keyOf(w.role, w.employeeId);
    if (kept.has(k)) continue;
    kept.add(k);
    const prev = byKey.get(k);
    if (prev) {
      if (w.credentials) {
        const merged = { ...((prev.credentials as Record<string, unknown> | null) ?? {}), ...w.credentials };
        await tx.projectTeamMember.update({ where: { id: prev.id }, data: { credentials: merged as Prisma.InputJsonValue } });
      }
    } else {
      await tx.projectTeamMember.create({
        data: { projectId, role: w.role, name: "", employeeId: w.employeeId ?? null, credentials: (w.credentials ?? {}) as Prisma.InputJsonValue },
      });
    }
  }
  const remove = existing.filter((e) => !kept.has(keyOf(e.role, e.employeeId))).map((e) => e.id);
  if (remove.length) await tx.projectTeamMember.deleteMany({ where: { id: { in: remove } } });
}

export async function update(fastify: FastifyInstance, tenantId: string, id: string, input: UpdateDossierInput) {
  const d = await fastify.prisma.project.findFirst({ where: { id, tenantId, kind: KIND }, select: { id: true, metadata: true } });
  if (!d) throw fastify.httpErrors.notFound("Dosarul nu a fost găsit");

  let groupPatch: { templateGroupId: string; distributorId: string | null; projectTypeId: string } | null = null;
  if (input.templateGroupId) {
    const group = await findGroup(fastify, tenantId, input.templateGroupId);
    const ptCode = CATEGORY_TO_PROJECT_TYPE_CODE[group.categoryCode];
    if (!ptCode) throw fastify.httpErrors.badRequest("Grupul ales nu e un dosar");
    const pt = await projectTypeFor(fastify, tenantId, ptCode);
    const distributor = await resolveDistributor(fastify, tenantId, group.distributorCode);
    groupPatch = { templateGroupId: group.id, distributorId: distributor?.id ?? null, projectTypeId: pt.id };
  }
  if (input.clientId) {
    const c = await fastify.prisma.client.findFirst({ where: { id: input.clientId, tenantId }, select: { id: true } });
    if (!c) throw fastify.httpErrors.notFound("Clientul nu a fost găsit");
  }
  const empIds = [...new Set((input.teamMembers ?? []).map((t) => t.employeeId).filter((x): x is string => !!x))];
  if (empIds.length) {
    const n = await fastify.prisma.employee.count({ where: { tenantId, id: { in: empIds } } });
    if (n !== empIds.length) throw fastify.httpErrors.badRequest("Unul dintre angajați nu a fost găsit");
  }

  let metadata: Record<string, unknown> | undefined;
  if (input.metadata) {
    const current = d.metadata && typeof d.metadata === "object" && !Array.isArray(d.metadata) ? (d.metadata as Record<string, unknown>) : {};
    metadata = { ...current };
    for (const [k, v] of Object.entries(input.metadata)) {
      if (v === null) delete metadata[k];
      else metadata[k] = v;
    }
  }

  await fastify.prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.address !== undefined && { address: input.address }),
        ...(input.city !== undefined && { city: input.city }),
        ...(input.county !== undefined && { county: input.county }),
        ...(input.clientId && { clientId: input.clientId }),
        ...(groupPatch ?? {}),
        ...(metadata && { metadata: metadata as Prisma.InputJsonValue }),
      },
    });
    if (input.teamMembers) await syncTeam(tx, id, input.teamMembers);
  });
  return get(fastify, tenantId, id);
}

export async function generate(fastify: FastifyInstance, tenantId: string, userId: string, id: string) {
  const d = await fastify.prisma.project.findFirst({ where: { id, tenantId, kind: KIND }, select: { id: true, templateGroupId: true } });
  if (!d) throw fastify.httpErrors.notFound("Dosarul nu a fost găsit");
  if (!d.templateGroupId) throw fastify.httpErrors.badRequest("Dosarul nu are ales un grup de documente");
  // Grupul se generează ca un singur ZIP; worker-ul îl desface pe membri.
  return documentsGenerate(fastify, tenantId, d.id, [d.templateGroupId], userId);
}

export async function remove(fastify: FastifyInstance, tenantId: string, id: string) {
  const d = await fastify.prisma.project.findFirst({ where: { id, tenantId, kind: KIND }, select: { id: true } });
  if (!d) throw fastify.httpErrors.notFound("Dosarul nu a fost găsit");
  // Documentele generate rămân (pot fi deja trimise); legăturile se șterg în cascadă.
  await fastify.prisma.project.delete({ where: { id } });
  return { success: true };
}
