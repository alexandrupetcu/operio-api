import type { FastifyInstance } from "fastify";
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  UpdateStepsInput,
} from "./workflow-templates.schema.js";

const stepSelect = {
  id: true,
  sortOrder: true,
  name: true,
  description: true,
  institution: true,
  estimatedDays: true,
  requiredDocuments: true,
  dependsOnStepOrder: true,
  isSelectable: true,
  isSelectedByDefault: true,
} as const;

export async function list(
  fastify: FastifyInstance,
  tenantId: string,
  projectType?: string
) {
  return fastify.prisma.workflowTemplate.findMany({
    where: {
      OR: [{ tenantId }, { tenantId: null }],
      isActive: true,
      ...(projectType && { projectType: projectType as any }),
    },
    include: {
      _count: { select: { steps: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getById(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const template = await fastify.prisma.workflowTemplate.findFirst({
    where: {
      id,
      OR: [{ tenantId }, { tenantId: null }],
    },
    include: {
      steps: { select: stepSelect, orderBy: { sortOrder: "asc" } },
    },
  });
  if (!template)
    throw fastify.httpErrors.notFound("Workflow template not found");
  return template;
}

export async function create(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateTemplateInput
) {
  // If setting as default, unset other defaults for this project type
  if (input.isDefault) {
    await fastify.prisma.workflowTemplate.updateMany({
      where: { tenantId, projectType: input.projectType, isDefault: true },
      data: { isDefault: false },
    });
  }

  return fastify.prisma.workflowTemplate.create({
    data: {
      tenantId,
      projectType: input.projectType,
      name: input.name,
      description: input.description,
      isDefault: input.isDefault,
      steps: {
        create: input.steps.map(({ id: _id, ...step }) => step),
      },
    },
    include: {
      steps: { select: stepSelect, orderBy: { sortOrder: "asc" } },
    },
  });
}

export async function update(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateTemplateInput
) {
  const template = await getById(fastify, tenantId, id);

  // Only allow editing own templates, not system ones
  if (template.tenantId === null) {
    throw fastify.httpErrors.forbidden("Cannot edit system templates");
  }

  if (input.isDefault) {
    await fastify.prisma.workflowTemplate.updateMany({
      where: {
        tenantId,
        projectType: template.projectType,
        isDefault: true,
        NOT: { id },
      },
      data: { isDefault: false },
    });
  }

  return fastify.prisma.workflowTemplate.update({
    where: { id },
    data: input,
    include: {
      steps: { select: stepSelect, orderBy: { sortOrder: "asc" } },
    },
  });
}

export async function updateSteps(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  input: UpdateStepsInput
) {
  const template = await getById(fastify, tenantId, id);

  if (template.tenantId === null) {
    throw fastify.httpErrors.forbidden("Cannot edit system templates");
  }

  // Replace all steps: delete existing, create new
  await fastify.prisma.$transaction([
    fastify.prisma.workflowTemplateStep.deleteMany({
      where: { templateId: id },
    }),
    ...input.steps.map((step) =>
      fastify.prisma.workflowTemplateStep.create({
        data: {
          templateId: id,
          sortOrder: step.sortOrder,
          name: step.name,
          description: step.description,
          institution: step.institution,
          estimatedDays: step.estimatedDays,
          requiredDocuments: step.requiredDocuments,
          dependsOnStepOrder: step.dependsOnStepOrder ?? null,
          isSelectable: step.isSelectable,
          isSelectedByDefault: step.isSelectedByDefault,
        },
      })
    ),
  ]);

  return getById(fastify, tenantId, id);
}

export async function remove(
  fastify: FastifyInstance,
  tenantId: string,
  id: string
) {
  const template = await getById(fastify, tenantId, id);

  if (template.tenantId === null) {
    throw fastify.httpErrors.forbidden("Cannot delete system templates");
  }

  return fastify.prisma.workflowTemplate.update({
    where: { id },
    data: { isActive: false },
  });
}
