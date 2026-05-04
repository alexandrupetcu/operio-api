import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { requireRole } from "../../lib/rbac.js";
import { z } from "zod";

const upsertSchema = z.object({
  role: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  employeeId: z.string().optional().nullable(),
  credentials: z
    .object({
      legitimatie: z.string().optional(),
      tip: z.string().optional(),
      valabilitate: z.string().optional(),
      autorizatie: z.string().optional(),
      autorizatii: z.string().optional(),
      poanson: z.string().optional(),
    })
    .passthrough()
    .optional()
    .nullable(),
});

export default async function projectTeamRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // GET /projects/:id/team — list team members
  fastify.get<{ Params: { id: string } }>("/:id/team", async (request) => {
    const project = await fastify.prisma.project.findFirst({
      where: { id: request.params.id, tenantId: request.tenantId },
    });
    if (!project) throw fastify.httpErrors.notFound("Project not found");

    return fastify.prisma.projectTeamMember.findMany({
      where: { projectId: project.id },
      include: { employee: { select: { id: true, firstName: true, lastName: true, position: true } } },
      orderBy: { createdAt: "asc" },
    });
  });

  // POST /projects/:id/team — add or update team member
  // For roles that allow multiples (sudor), always creates new.
  // For unique roles, updates existing if found.
  fastify.post<{ Params: { id: string } }>(
    "/:id/team",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = upsertSchema.parse(request.body);
      const project = await fastify.prisma.project.findFirst({
        where: { id: request.params.id, tenantId: request.tenantId },
      });
      if (!project) throw fastify.httpErrors.notFound("Project not found");

      const credentialsValue = body.credentials === null
        ? Prisma.JsonNull
        : body.credentials === undefined
          ? undefined
          : (body.credentials as Prisma.InputJsonValue);

      const MULTI_ROLES = ["sudor"];
      let member;

      if (MULTI_ROLES.includes(body.role)) {
        // Allow multiple members with same role
        member = await fastify.prisma.projectTeamMember.create({
          data: {
            projectId: project.id,
            role: body.role,
            name: body.name,
            employeeId: body.employeeId ?? null,
            credentials: credentialsValue,
          },
          include: { employee: { select: { id: true, firstName: true, lastName: true, position: true } } },
        });
      } else {
        // Unique role — find existing and update, or create
        const existing = await fastify.prisma.projectTeamMember.findFirst({
          where: { projectId: project.id, role: body.role },
        });
        if (existing) {
          member = await fastify.prisma.projectTeamMember.update({
            where: { id: existing.id },
            data: {
              name: body.name,
              employeeId: body.employeeId ?? null,
              credentials: credentialsValue,
            },
            include: { employee: { select: { id: true, firstName: true, lastName: true, position: true } } },
          });
        } else {
          member = await fastify.prisma.projectTeamMember.create({
            data: {
              projectId: project.id,
              role: body.role,
              name: body.name,
              employeeId: body.employeeId ?? null,
              credentials: credentialsValue,
            },
            include: { employee: { select: { id: true, firstName: true, lastName: true, position: true } } },
          });
        }
      }

      return reply.status(200).send(member);
    }
  );

  // DELETE /projects/:id/team/:memberId — remove team member
  fastify.delete<{ Params: { id: string; memberId: string } }>(
    "/:id/team/:memberId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const project = await fastify.prisma.project.findFirst({
        where: { id: request.params.id, tenantId: request.tenantId },
      });
      if (!project) throw fastify.httpErrors.notFound("Project not found");

      const member = await fastify.prisma.projectTeamMember.findFirst({
        where: { id: request.params.memberId, projectId: project.id },
      });
      if (!member) throw fastify.httpErrors.notFound("Team member not found");

      await fastify.prisma.projectTeamMember.delete({ where: { id: member.id } });
      return { success: true };
    }
  );
}
