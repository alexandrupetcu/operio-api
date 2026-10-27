import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { hashPassword } from "../../lib/hash.js";
import authPlugin from "../../plugins/auth.js";
import tenantPlugin from "../../plugins/tenant.js";
import authRoutes from "../auth/auth.routes.js";
import clientsRoutes from "../clients/clients.routes.js";
import appointmentsRoutes from "../appointments/appointments.routes.js";
import adminRoutes from "./admin.routes.js";
import { readOnlyGuardPlugin, impersonationRoutes, READ_ONLY_MESSAGE } from "./impersonation.js";

/**
 * Impersonarea „doar citire” pe o aplicație Fastify reală (JWT, garda globală,
 * rutele adevărate) — fără `buildServer()`, care ar cere Redis și S3.
 */

const PASSWORD = "Master-Parola-1";
let app: FastifyInstance;
let f: TwoTenants;
let masterId: string;
let masterToken: string;

async function buildApp() {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  instance.decorate("prisma", prisma as never);
  await instance.register(authPlugin);
  await instance.register(tenantPlugin);
  await instance.register(readOnlyGuardPlugin);
  await instance.register(authRoutes, { prefix: "/api/auth" });
  await instance.register(clientsRoutes, { prefix: "/api/clients" });
  await instance.register(appointmentsRoutes, { prefix: "/api/appointments" });
  await instance.register(adminRoutes, { prefix: "/api/admin" });
  await instance.register(impersonationRoutes, { prefix: "/api/admin/impersonation" });
  await instance.ready();
  return instance;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  f = await seedTwoTenants();
  const master = await prisma.user.create({
    data: { email: "master@fixture.test", passwordHash: await hashPassword(PASSWORD), firstName: "Platform", lastName: "Master", role: "MASTER_ADMIN" },
  });
  masterId = master.id;
  app = await buildApp();
  masterToken = app.jwt.sign({ sub: masterId, tenantId: null, role: "MASTER_ADMIN", client: "web" });
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function impersonate(tenantId = f.a.id, password = PASSWORD) {
  return app.inject({ method: "POST", url: `/api/admin/tenants/${tenantId}/impersonate`, headers: auth(masterToken), payload: { password } });
}

describe("POST /admin/tenants/:id/impersonate", () => {
  it("parola greșită → 401; firmă necunoscută → 404; fără drept master → 403", async () => {
    expect((await impersonate(f.a.id, "gresit")).statusCode).toBe(401);
    expect((await impersonate("ckzzzzzzzzzzzzzzzzzzzzzzz")).statusCode).toBe(404);
    const adminToken = app.jwt.sign({ sub: f.a.admin.id, tenantId: f.a.id, role: "ADMIN", client: "web" });
    const res = await app.inject({ method: "POST", url: `/api/admin/tenants/${f.b.id}/impersonate`, headers: auth(adminToken), payload: { password: PASSWORD } });
    expect(res.statusCode).toBe(403);
  });

  it("parola corectă → token de acces de 60 min (fără refresh), audit impersonate_start în firmă", async () => {
    const res = await impersonate();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant).toEqual({ id: f.a.id, name: expect.any(String) });
    expect(body.refreshToken).toBeUndefined();
    const decoded = app.jwt.decode<{ sub: string; tenantId: string; role: string; imp: { by: string; readOnly: boolean }; exp: number; iat: number }>(body.accessToken)!;
    expect(decoded).toMatchObject({ sub: masterId, tenantId: f.a.id, role: "ADMIN", imp: { by: masterId, readOnly: true } });
    expect(decoded.exp - decoded.iat).toBe(3600);
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: f.a.id, action: "impersonate_start" } });
    expect(audit).toMatchObject({ actorUserId: masterId, entityType: "tenant", entityId: f.a.id });
  });
});

describe("sesiunea de impersonare (doar citire)", () => {
  it("/auth/me arată firma țintă, rolul ADMIN și blocul impersonation", async () => {
    const { accessToken } = (await impersonate()).json();
    const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(accessToken) })).json();
    expect(me.user).toMatchObject({ id: masterId, role: "ADMIN", tenantId: f.a.id });
    expect(me.tenant.id).toBe(f.a.id);
    expect(me.employee).toBeNull();
    expect(me.impersonation).toMatchObject({ tenantId: f.a.id, readOnly: true, expiresAt: expect.any(String) });
    // Un token normal nu are blocul impersonation.
    const normal = (await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(masterToken) })).json();
    expect(normal.impersonation).toBeUndefined();
  });

  it("citirile firmei merg (clienți, calendar); scrierile → 403 cu mesajul de doar citire", async () => {
    const { accessToken } = (await impersonate()).json();
    const clients = await app.inject({ method: "GET", url: "/api/clients", headers: auth(accessToken) });
    expect(clients.statusCode).toBe(200);
    expect(clients.json().data.map((c: { id: string }) => c.id)).toContain(f.a.clientId);
    const cal = await app.inject({
      method: "GET",
      url: "/api/appointments/calendar?from=2026-10-01T00:00:00.000Z&to=2026-10-31T23:59:59.000Z",
      headers: auth(accessToken),
    });
    expect(cal.statusCode).toBe(200);
    expect(cal.json().map((a: { id: string }) => a.id)).toContain(f.a.appointmentId);

    const create = await app.inject({ method: "POST", url: "/api/clients", headers: auth(accessToken), payload: { type: "PERSON", firstName: "X", lastName: "Y" } });
    expect(create.statusCode).toBe(403);
    expect(create.json().message).toBe(READ_ONLY_MESSAGE);
    const patch = await app.inject({ method: "PATCH", url: `/api/appointments/${f.a.appointmentId}`, headers: auth(accessToken), payload: { title: "nu" } });
    expect(patch.statusCode).toBe(403);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: f.a.appointmentId } })).title).not.toBe("nu");
    // Paginile master nu sunt accesibile din sesiunea de firmă.
    expect((await app.inject({ method: "GET", url: "/api/admin/overview", headers: auth(accessToken) })).statusCode).toBe(403);
  });

  it("ieșirea: /admin/impersonation/end → 204 + audit; logout nu revocă sesiunile contului master", async () => {
    const { accessToken } = (await impersonate()).json();
    await prisma.refreshToken.create({ data: { userId: masterId, token: "hash-master", expiresAt: new Date(Date.now() + 86_400_000) } });
    const end = await app.inject({ method: "POST", url: "/api/admin/impersonation/end", headers: auth(accessToken) });
    expect(end.statusCode).toBe(204);
    expect(await prisma.auditLog.count({ where: { tenantId: f.a.id, action: "impersonate_end", actorUserId: masterId } })).toBe(1);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: auth(accessToken) });
    expect(out.statusCode).toBe(200);
    expect(await prisma.refreshToken.count({ where: { userId: masterId } })).toBe(1);
    // Fără impersonare, ieșirea nu are sens.
    expect((await app.inject({ method: "POST", url: "/api/admin/impersonation/end", headers: auth(masterToken) })).statusCode).toBe(400);
  });
});

describe("panoul platformei și firmele", () => {
  it("overview: firme, utilizatori, activitate, cozi (zero când Redis lipsește)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/overview", headers: auth(masterToken) });
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.tenants.total).toBe(2);
    expect(o.tenants.byPlan.field + o.tenants.byPlan.execution + o.tenants.byPlan.none).toBe(2);
    expect(o.users).toMatchObject({ total: 4, active: 4 });
    expect(o.activity).toEqual(expect.objectContaining({ dossiersTotal: expect.any(Number), projectsTotal: expect.any(Number) }));
    expect(o.queues.documentGeneration).toEqual(expect.objectContaining({ failed: expect.any(Number) }));
    expect(o.recentTenants).toHaveLength(2);
  });

  it("lista de firme are counts + lastActivityAt; detaliul are utilizatorii cu ultima conectare", async () => {
    await prisma.refreshToken.create({ data: { userId: f.a.admin.id, token: "hash-a", expiresAt: new Date(Date.now() + 86_400_000) } });
    const list = (await app.inject({ method: "GET", url: "/api/admin/tenants", headers: auth(masterToken) })).json();
    const a = list.find((t: { id: string }) => t.id === f.a.id);
    expect(a.counts).toEqual({ users: 2, mobileUsers: 0, clients: 1, projects: 0, dossiers: 0, appointmentsLast30d: expect.any(Number), documents: expect.any(Number) });
    expect(a.lastActivityAt).toEqual(expect.any(String));
    expect(a.usersCount).toBe(2);

    const detail = await app.inject({ method: "GET", url: `/api/admin/tenants/${f.a.id}`, headers: auth(masterToken) });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d).toMatchObject({ id: f.a.id, counts: { users: 2 }, entitlements: expect.any(Object) });
    const admin = d.users.find((u: { id: string }) => u.id === f.a.admin.id);
    expect(admin.lastLoginAt).toEqual(expect.any(String));
    const operator = d.users.find((u: { id: string }) => u.id === f.a.operator.id);
    expect(operator.employee).toMatchObject({ id: f.a.employeeId });
    expect((await app.inject({ method: "GET", url: "/api/admin/tenants/ckzzzzzzzzzzzzzzzzzzzzzzz", headers: auth(masterToken) })).statusCode).toBe(404);
  });
});
