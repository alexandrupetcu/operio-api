import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import PizZip from "pizzip";
import { uploadFile, deleteFile, getPresignedUrl, getFileBuffer } from "../../lib/s3.js";
import { safeS3Filename, uploadContentType } from "../../lib/safe-filename.js";
import { archiveEntryNames } from "../../lib/archive-names.js";
import type { CreateTemplateInput, UpdateTemplateInput } from "./templates.schema.js";

type TemplateTypeFilter = "all" | "html" | "docx" | "group";

/** Where-fragment for the list type filter (html/docx are inferred from content/s3Key). */
function typeWhere(type?: TemplateTypeFilter) {
  if (type === "group") return { type: "group" } as const;
  if (type === "docx") return { type: "single", s3Key: { not: null } } as const;
  if (type === "html") return { type: "single", content: { not: null } } as const;
  return {} as const;
}

const listInclude = { category: true, _count: { select: { groupMembers: true } } } as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  opts: { category?: string; search?: string; type?: TemplateTypeFilter; page?: number; limit?: number }
) {
  const { category, search, type, page = 1, limit = 10 } = opts;
  const skip = (page - 1) * limit;

  const where = {
    OR: [{ tenantId }, { tenantId: null }],
    parentGroupId: null, // hide group members from the top-level list
    ...typeWhere(type),
    ...(category && { categoryCode: category }),
    ...(search && {
      AND: {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { description: { contains: search, mode: "insensitive" as const } },
        ],
      },
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.documentTemplate.findMany({
      where,
      include: listInclude,
      orderBy: [{ categoryCode: "asc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    fastify.prisma.documentTemplate.count({ where }),
  ]);

  return {
    data,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { tenantId: null }] },
    include: { category: true },
  });
  if (!template) throw fastify.httpErrors.notFound("Template not found");
  return template;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateTemplateInput
) {
  return fastify.prisma.documentTemplate.create({
    data: {
      tenantId,
      categoryCode: input.category,
      name: input.name,
      description: input.description,
      content: input.content,
    },
  });
}

export async function createFromFile(
  fastify: FastifyInstance,
  tenantId: string,
  file: MultipartFile,
  name: string,
  category: string
) {
  const buffer = await file.toBuffer();
  const s3Key = `templates/${tenantId}/${Date.now()}-${safeS3Filename(file.filename)}`;
  // Content-type după extensie, nu după antetul clientului.
  await uploadFile(s3Key, buffer, uploadContentType(file.filename));

  return fastify.prisma.documentTemplate.create({
    data: { tenantId, name, categoryCode: category, s3Key },
  });
}

/** Global (platform-wide, `tenantId: null`) rows may only be changed by MASTER_ADMIN. */
function assertCanMutateGlobal(fastify: FastifyInstance, role: string | undefined) {
  if (role !== "MASTER_ADMIN") {
    throw fastify.httpErrors.forbidden("Doar administratorul platformei poate modifica template-urile globale");
  }
}

/** Who is asking: tenant admins reach their own + global rows, MASTER_ADMIN reaches every row. */
export interface TemplateScope {
  tenantId: string;
  role?: string;
}

async function findScoped(fastify: FastifyInstance, id: string, scope: TemplateScope) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: {
      id,
      ...(scope.role !== "MASTER_ADMIN" && { OR: [{ tenantId: scope.tenantId }, { tenantId: null }] }),
    },
  });
  if (!template) throw fastify.httpErrors.notFound("Template not found");
  return template;
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateTemplateInput,
  role?: string
) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { tenantId: null }] },
  });
  if (!template) throw fastify.httpErrors.notFound("Template not found");

  const { category, source, ...rest } = input;
  // Touching a global row, or moving a row to/from global scope, is master-only.
  if (template.tenantId === null || (source && source !== "tenant")) {
    assertCanMutateGlobal(fastify, role);
  }
  return fastify.prisma.documentTemplate.update({
    where: { id },
    data: {
      ...rest,
      ...(category && { categoryCode: category }),
      // Move between global ("system") and the current tenant.
      ...(source && { tenantId: source === "tenant" ? tenantId : null }),
    },
  });
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  role?: string
) {
  const template = await fastify.prisma.documentTemplate.findFirst({
    where: { id, OR: [{ tenantId }, { tenantId: null }] },
  });
  if (!template)
    throw fastify.httpErrors.notFound("Template not found");
  if (template.tenantId === null) assertCanMutateGlobal(fastify, role);

  return fastify.prisma.documentTemplate.delete({ where: { id } });
}

export async function bulkRemove(
  fastify: FastifyInstance,
  tenantId: string,
  ids: string[],
  role?: string
) {
  const result = await fastify.prisma.documentTemplate.deleteMany({
    where: {
      id: { in: ids },
      // Tenant admins delete only their own rows; global rows are master-only.
      ...(role === "MASTER_ADMIN" ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId }),
    },
  });
  return { deleted: result.count };
}

// ── Admin-only functions ──────────────────────────────────────────────

export async function listAdmin(
  fastify: FastifyInstance,
  opts: {
    category?: string;
    search?: string;
    scope?: "all" | "system" | "tenant";
    type?: TemplateTypeFilter;
    page?: number;
    limit?: number;
  }
) {
  const { category, search, scope = "all", type, page = 1, limit = 10 } = opts;
  const skip = (page - 1) * limit;

  const where = {
    parentGroupId: null, // hide group members from the top-level list
    ...typeWhere(type),
    ...(scope === "system" && { tenantId: null }),
    ...(scope === "tenant" && { tenantId: { not: null } }),
    ...(category && { categoryCode: category }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { description: { contains: search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    fastify.prisma.documentTemplate.findMany({
      where,
      include: listInclude,
      orderBy: [{ categoryCode: "asc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    fastify.prisma.documentTemplate.count({ where }),
  ]);

  return { data, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getDownloadUrl(
  fastify: FastifyInstance,
  id: string,
  scope: TemplateScope
) {
  const template = await findScoped(fastify, id, scope);
  if (!template.s3Key)
    throw fastify.httpErrors.badRequest("Template has no file to download");

  const url = await getPresignedUrl(template.s3Key, 3600);
  return { url, filename: template.fileName || template.name };
}

/** Raw DOCX bytes of a template (for the in-app editor — same-origin, no CORS). */
export async function getFileContent(fastify: FastifyInstance, id: string, scope: TemplateScope) {
  const template = await findScoped(fastify, id, scope);
  if (!template.s3Key) throw fastify.httpErrors.badRequest("Template has no file");
  const buffer = await getFileBuffer(template.s3Key);
  return { buffer, filename: template.fileName || template.name };
}

export async function replaceFile(
  fastify: FastifyInstance,
  id: string,
  file: MultipartFile,
  scope: TemplateScope
) {
  const template = await findScoped(fastify, id, scope);
  if (template.tenantId === null) assertCanMutateGlobal(fastify, scope.role);
  if (!template.s3Key)
    throw fastify.httpErrors.badRequest("Template is not a file-based template");

  // Delete old file (best-effort)
  try {
    await deleteFile(template.s3Key);
  } catch (err) {
    fastify.log.warn({ err, s3Key: template.s3Key }, "Failed to delete old template file");
  }

  // Upload new file
  const buffer = await file.toBuffer();
  const folder = template.tenantId ?? "system";
  const newS3Key = `templates/${folder}/${Date.now()}-${safeS3Filename(file.filename)}`;
  await uploadFile(newS3Key, buffer, uploadContentType(file.filename));

  return fastify.prisma.documentTemplate.update({
    where: { id },
    data: { s3Key: newS3Key },
  });
}

// ── DOCX Groups ───────────────────────────────────────────────────────

/** Create a DOCX group (a parent bundle; members are added afterwards). */
export async function createGroup(
  fastify: FastifyInstance,
  tenantId: string,
  input: { name: string; category: string; description?: string }
) {
  return fastify.prisma.documentTemplate.create({
    data: {
      tenantId,
      categoryCode: input.category,
      name: input.name,
      description: input.description,
      type: "group",
    },
  });
}

async function getGroupOrThrow(fastify: FastifyInstance, tenantId: string, groupId: string) {
  const group = await fastify.prisma.documentTemplate.findFirst({
    where: { id: groupId, type: "group", OR: [{ tenantId }, { tenantId: null }] },
  });
  if (!group) throw fastify.httpErrors.notFound("Group not found");
  return group;
}

/** Same lookup, for changes: a global group's members are master-only. */
async function getMutableGroupOrThrow(fastify: FastifyInstance, tenantId: string, groupId: string, role?: string) {
  const group = await getGroupOrThrow(fastify, tenantId, groupId);
  if (group.tenantId === null) assertCanMutateGlobal(fastify, role);
  return group;
}

/** Ordered DOCX members of a group. */
export async function listGroupDocs(fastify: FastifyInstance, tenantId: string, groupId: string) {
  await getGroupOrThrow(fastify, tenantId, groupId);
  return fastify.prisma.documentTemplate.findMany({
    where: { parentGroupId: groupId },
    orderBy: { memberOrder: "asc" },
    take: 200,
  });
}

/** Upload one or more DOCX files into a group as ordered members. */
export async function addGroupDocs(
  fastify: FastifyInstance,
  tenantId: string,
  groupId: string,
  files: Array<{ buffer: Buffer; filename: string; mimetype: string; name?: string }>,
  role?: string
) {
  const group = await getMutableGroupOrThrow(fastify, tenantId, groupId, role);
  const last = await fastify.prisma.documentTemplate.findFirst({
    where: { parentGroupId: groupId },
    orderBy: { memberOrder: "desc" },
    select: { memberOrder: true },
  });
  let order = (last?.memberOrder ?? -1) + 1;

  const created = [];
  for (const f of files) {
    const s3Key = `templates/${group.tenantId ?? "system"}/${Date.now()}-${safeS3Filename(f.filename)}`;
    await uploadFile(s3Key, f.buffer, f.mimetype);
    created.push(
      await fastify.prisma.documentTemplate.create({
        data: {
          tenantId: group.tenantId,
          categoryCode: group.categoryCode,
          name: f.name?.trim() || f.filename.replace(/\.docx$/i, ""),
          s3Key,
          type: "single",
          parentGroupId: groupId,
          memberOrder: order++,
        },
      })
    );
  }
  return created;
}

/** Remove a member from a group (best-effort S3 cleanup). */
export async function removeGroupDoc(
  fastify: FastifyInstance,
  tenantId: string,
  groupId: string,
  docId: string,
  role?: string
) {
  await getMutableGroupOrThrow(fastify, tenantId, groupId, role);
  const doc = await fastify.prisma.documentTemplate.findFirst({
    where: { id: docId, parentGroupId: groupId },
  });
  if (!doc) throw fastify.httpErrors.notFound("Document not found in group");
  if (doc.s3Key) {
    try {
      await deleteFile(doc.s3Key);
    } catch (err) {
      fastify.log.warn({ err, s3Key: doc.s3Key }, "Failed to delete group member file");
    }
  }
  return fastify.prisma.documentTemplate.delete({ where: { id: docId } });
}

/** Reorder a group's members to match the given id order. */
export async function reorderGroupDocs(
  fastify: FastifyInstance,
  tenantId: string,
  groupId: string,
  ids: string[],
  role?: string
) {
  await getMutableGroupOrThrow(fastify, tenantId, groupId, role);
  await fastify.prisma.$transaction(
    ids.map((id, idx) =>
      fastify.prisma.documentTemplate.updateMany({
        where: { id, parentGroupId: groupId },
        data: { memberOrder: idx },
      })
    )
  );
  return listGroupDocs(fastify, tenantId, groupId);
}

/** Build a ZIP of the group's member DOCX files. Returns { buffer, filename }. */
export async function getGroupZip(fastify: FastifyInstance, tenantId: string, groupId: string) {
  const group = await getGroupOrThrow(fastify, tenantId, groupId);
  const members = await fastify.prisma.documentTemplate.findMany({
    where: { parentGroupId: groupId, s3Key: { not: null } },
    orderBy: { memberOrder: "asc" },
  });
  if (members.length === 0) throw fastify.httpErrors.badRequest("Group has no documents");

  const zip = new PizZip();
  const entries = archiveEntryNames(members);
  for (const [i, m] of members.entries()) {
    zip.file(entries[i], await getFileBuffer(m.s3Key!));
  }
  const buffer = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
  const filename = `${group.name.replace(/[^\w.-]+/g, "_")}.zip`;
  return { buffer, filename };
}
