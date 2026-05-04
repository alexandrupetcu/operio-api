import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { createClientSchema, updateClientSchema, equipmentInputSchema, clientAddressInputSchema } from "./clients.schema.js";
import * as clientsService from "./clients.service.js";

export default async function clientsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    const { status } = request.query as Record<string, string>;
    return clientsService.list(fastify, request.tenantId, { ...query, status });
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return clientsService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createClientSchema.parse(request.body);
      const client = await clientsService.create(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(client);
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = updateClientSchema.parse(request.body);
      return clientsService.update(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return clientsService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // === Address standalone endpoints ===

  fastify.post<{ Params: { id: string } }>(
    "/:id/addresses",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = clientAddressInputSchema.parse(request.body);
      const addr = await clientsService.addAddress(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
      return reply.status(201).send(addr);
    }
  );

  fastify.patch<{ Params: { id: string; addressId: string } }>(
    "/:id/addresses/:addressId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = clientAddressInputSchema.partial().parse(request.body);
      return clientsService.updateAddress(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.addressId,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string; addressId: string } }>(
    "/:id/addresses/:addressId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return clientsService.removeAddress(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.addressId
      );
    }
  );

  // === Equipment standalone endpoints ===

  fastify.get<{ Params: { id: string } }>(
    "/:id/equipment",
    async (request) => {
      const client = await fastify.prisma.client.findFirst({
        where: { id: request.params.id, tenantId: request.tenantId },
      });
      if (!client) throw fastify.httpErrors.notFound("Client not found");
      return fastify.prisma.equipment.findMany({
        where: { clientId: client.id },
        orderBy: { createdAt: "asc" },
      });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/:id/equipment",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = equipmentInputSchema.parse(request.body);
      const eq = await clientsService.addEquipment(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
      return reply.status(201).send(eq);
    }
  );

  fastify.patch<{ Params: { id: string; equipmentId: string } }>(
    "/:id/equipment/:equipmentId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = equipmentInputSchema.partial().parse(request.body);
      return clientsService.updateEquipment(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId,
        body
      );
    }
  );

  fastify.delete<{ Params: { id: string; equipmentId: string } }>(
    "/:id/equipment/:equipmentId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return clientsService.removeEquipment(
        fastify,
        request.tenantId,
        request.params.id,
        request.params.equipmentId
      );
    }
  );
}
