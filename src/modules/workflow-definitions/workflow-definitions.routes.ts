import type { FastifyInstance } from "fastify";
import { requireRole, requireMasterAdmin } from "../../lib/rbac.js";
import {
  createWorkflowDefinitionSchema,
  updateWorkflowDefinitionSchema,
  createStepSchema,
  updateStepSchema,
  createTransitionSchema,
  updateTransitionSchema,
  createStepActionSchema,
  updateStepActionSchema,
  cloneWorkflowSchema,
} from "./workflow-definitions.schema.js";
import * as service from "./workflow-definitions.service.js";

export default async function workflowDefinitionsRoutes(
  fastify: FastifyInstance
) {
  fastify.addHook("onRequest", fastify.authenticate);

  // Helper: resolve tenantId — for master admins operating on master workflows, use null
  const resolveTenantId = (request: { tenantId: string; isMasterAdmin: boolean }): string | null =>
    request.isMasterAdmin && !request.tenantId ? null : request.tenantId;

  // ─── Definition CRUD ───────────────────────────────────────────────────────

  fastify.get("/", async (request) => {
    const { status, projectTypeId, category } = request.query as Record<string, string>;
    return service.list(fastify, resolveTenantId(request), { status, projectTypeId, category });
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return service.getById(fastify, resolveTenantId(request), request.params.id);
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createWorkflowDefinitionSchema.parse(request.body);
      const tid = resolveTenantId(request);
      const definition = tid
        ? await service.create(fastify, tid, request.user.sub, body)
        : await service.createMaster(fastify, request.user.sub, body);
      return reply.status(201).send(definition);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateWorkflowDefinitionSchema.parse(request.body);
      const tid = resolveTenantId(request);
      return tid
        ? service.update(fastify, tid, request.params.id, body)
        : service.updateMaster(fastify, request.params.id, body);
    }
  );

  // ─── Steps ─────────────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    "/:id/steps",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createStepSchema.parse(request.body);
      const step = await service.addStep(
        fastify,
        resolveTenantId(request),
        request.params.id,
        body
      );
      return reply.status(201).send(step);
    }
  );

  fastify.patch<{ Params: { stepId: string } }>(
    "/steps/:stepId",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateStepSchema.parse(request.body);
      return service.updateStep(
        fastify,
        resolveTenantId(request),
        request.params.stepId,
        body
      );
    }
  );

  fastify.delete<{ Params: { stepId: string } }>(
    "/steps/:stepId",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return service.removeStep(
        fastify,
        resolveTenantId(request),
        request.params.stepId
      );
    }
  );

  // ─── Transitions ───────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    "/:id/transitions",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createTransitionSchema.parse(request.body);
      const transition = await service.addTransition(
        fastify,
        resolveTenantId(request),
        request.params.id,
        body
      );
      return reply.status(201).send(transition);
    }
  );

  fastify.patch<{ Params: { transitionId: string } }>(
    "/transitions/:transitionId",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateTransitionSchema.parse(request.body);
      return service.updateTransition(
        fastify,
        resolveTenantId(request),
        request.params.transitionId,
        body
      );
    }
  );

  fastify.delete<{ Params: { transitionId: string } }>(
    "/transitions/:transitionId",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return service.removeTransition(
        fastify,
        resolveTenantId(request),
        request.params.transitionId
      );
    }
  );

  // ─── Step Actions ──────────────────────────────────────────────────────────

  fastify.post<{ Params: { stepId: string } }>(
    "/steps/:stepId/actions",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = createStepActionSchema.parse(request.body);
      const action = await service.addStepAction(fastify, resolveTenantId(request), {
        ...body,
        stepId: request.params.stepId,
      });
      return reply.status(201).send(action);
    }
  );

  fastify.patch<{ Params: { actionId: string } }>(
    "/step-actions/:actionId",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      const body = updateStepActionSchema.parse(request.body);
      return service.updateStepAction(
        fastify,
        resolveTenantId(request),
        request.params.actionId,
        body
      );
    }
  );

  fastify.delete<{ Params: { actionId: string } }>(
    "/step-actions/:actionId",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return service.removeStepAction(
        fastify,
        resolveTenantId(request),
        request.params.actionId
      );
    }
  );

  // ─── Workflow Operations ───────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    "/:id/validate",
    async (request) => {
      return service.validate(fastify, resolveTenantId(request), request.params.id);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/publish",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return service.publish(fastify, resolveTenantId(request), request.params.id);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/clone",
    { onRequest: [requireRole("ADMIN")] },
    async (request, reply) => {
      const body = cloneWorkflowSchema.parse(request.body);
      // Clone always goes INTO the user's tenant (even if source is a master workflow)
      if (!request.tenantId) {
        throw fastify.httpErrors.badRequest(
          "Master admins must specify a target tenant to clone into"
        );
      }
      const cloned = await service.clone(
        fastify,
        request.tenantId,
        request.params.id,
        request.user.sub,
        body
      );
      return reply.status(201).send(cloned);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/archive",
    { onRequest: [requireRole("ADMIN")] },
    async (request) => {
      return service.archive(fastify, resolveTenantId(request), request.params.id);
    }
  );

  fastify.get<{ Params: { code: string } }>(
    "/by-code/:code/versions",
    async (request) => {
      return service.getVersions(
        fastify,
        request.tenantId,
        request.params.code
      );
    }
  );
}
