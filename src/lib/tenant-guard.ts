import type { FastifyInstance } from "fastify";

/**
 * Verificări de apartenență la tenant pentru id-uri venite din body.
 *
 * Fiecare helper primește id-ul (poate fi null/undefined — atunci nu face nimic,
 * ca să se poată apela direct pe câmpuri opționale) și aruncă 400 dacă rândul
 * nu există sau aparține altei firme. 400, nu 404: id-ul e o valoare din
 * payload, nu resursa cerută în URL.
 *
 * Entitățile fără `tenantId` propriu (Equipment, GasInstallation, ClientAddress)
 * se verifică prin clientul părinte.
 *
 * Acceptă orice obiect cu `prisma` + `httpErrors` ca să meargă și din scripturi
 * cu un stub de fastify.
 */
export type GuardDeps = Pick<FastifyInstance, "prisma" | "httpErrors">;

type Id = string | null | undefined;

function reject(fastify: GuardDeps, what: string): never {
  throw fastify.httpErrors.badRequest(`${what} nu aparține firmei`);
}

export async function assertClientInTenant(fastify: GuardDeps, tenantId: string, clientId: Id) {
  if (!clientId) return;
  const n = await fastify.prisma.client.count({ where: { id: clientId, tenantId } });
  if (n === 0) reject(fastify, "Clientul");
}

export async function assertEmployeeInTenant(fastify: GuardDeps, tenantId: string, employeeId: Id) {
  if (!employeeId) return;
  const n = await fastify.prisma.employee.count({ where: { id: employeeId, tenantId } });
  if (n === 0) reject(fastify, "Angajatul");
}

export async function assertUserInTenant(fastify: GuardDeps, tenantId: string, userId: Id) {
  if (!userId) return;
  const n = await fastify.prisma.user.count({ where: { id: userId, tenantId } });
  if (n === 0) reject(fastify, "Utilizatorul");
}

export async function assertVehicleInTenant(fastify: GuardDeps, tenantId: string, vehicleId: Id) {
  if (!vehicleId) return;
  const n = await fastify.prisma.vehicle.count({ where: { id: vehicleId, tenantId } });
  if (n === 0) reject(fastify, "Vehiculul");
}

export async function assertProjectInTenant(fastify: GuardDeps, tenantId: string, projectId: Id) {
  if (!projectId) return;
  const n = await fastify.prisma.project.count({ where: { id: projectId, tenantId } });
  if (n === 0) reject(fastify, "Proiectul");
}

export async function assertDocumentInTenant(fastify: GuardDeps, tenantId: string, documentId: Id) {
  if (!documentId) return;
  const n = await fastify.prisma.document.count({ where: { id: documentId, tenantId } });
  if (n === 0) reject(fastify, "Documentul");
}

export async function assertWorkflowInstanceInTenant(fastify: GuardDeps, tenantId: string, instanceId: Id) {
  if (!instanceId) return;
  const n = await fastify.prisma.workflowInstance.count({ where: { id: instanceId, tenantId } });
  if (n === 0) reject(fastify, "Instanța de workflow");
}

export async function assertWorkflowStepInstanceInTenant(fastify: GuardDeps, tenantId: string, stepId: Id) {
  if (!stepId) return;
  const n = await fastify.prisma.workflowStepInstance.count({ where: { id: stepId, tenantId } });
  if (n === 0) reject(fastify, "Pasul de workflow");
}

/**
 * Echipament → client → tenant. Cu `clientId` dat, cere și ca echipamentul să fie
 * al acelui client (nu doar al firmei).
 */
export async function assertEquipmentInTenant(
  fastify: GuardDeps,
  tenantId: string,
  equipmentId: Id,
  clientId?: Id
) {
  if (!equipmentId) return;
  const n = await fastify.prisma.equipment.count({
    where: { id: equipmentId, client: { tenantId }, ...(clientId && { clientId }) },
  });
  if (n === 0) {
    if (clientId) throw fastify.httpErrors.badRequest("Echipamentul nu aparține clientului");
    reject(fastify, "Echipamentul");
  }
}

/** Instalație de gaz → client → tenant; opțional și al clientului dat. */
export async function assertInstallationInTenant(
  fastify: GuardDeps,
  tenantId: string,
  installationId: Id,
  clientId?: Id
) {
  if (!installationId) return;
  const n = await fastify.prisma.gasInstallation.count({
    where: { id: installationId, client: { tenantId }, ...(clientId && { clientId }) },
  });
  if (n === 0) {
    if (clientId) throw fastify.httpErrors.badRequest("Instalația nu aparține clientului");
    reject(fastify, "Instalația");
  }
}

/** Adresa trebuie să fie a clientului indicat (clientul e deja verificat de apelant). */
export async function assertAddressOfClient(fastify: GuardDeps, clientId: string, addressId: Id) {
  if (!addressId) return;
  const n = await fastify.prisma.clientAddress.count({ where: { id: addressId, clientId } });
  if (n === 0) throw fastify.httpErrors.badRequest("Adresa nu aparține clientului");
}
