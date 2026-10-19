import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import planExpiryPlugin from "../../plugins/plan-expiry.js";
import { requireFeature } from "./guard.js";
import { invalidateEntitlements } from "./resolve.js";

/**
 * Garda de abonament e un `preHandler` Fastify, deci se testează pe o aplicație
 * reală — dar una minimală: `sensible` + un decorator `prisma` + un hook care
 * pune `request.user` / `request.tenantId` în locul plugin-ului de autentificare
 * (JWT-ul nu aduce nimic la ce verificăm aici). NU folosim `buildServer()`:
 * acela montează Bull Board și cozi, deci ar cere Redis.
 */

let app: FastifyInstance;
let f: TwoTenants;
/** Sesiunea simulată pentru cererea următoare. */
let session: { sub: string; tenantId: string | null; role: string } | null = null;

async function buildGuardedApp() {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  instance.decorate("prisma", prisma as never);
  instance.decorateRequest("tenantId", "");
  instance.decorateRequest("isMasterAdmin", false);

  // Ținem forma plugin-urilor reale: `request.user` din JWT, apoi tenantId.
  instance.addHook("onRequest", async (request) => {
    if (session) {
      (request as { user?: unknown }).user = session;
      request.tenantId = session.tenantId ?? "";
      request.isMasterAdmin = session.role === "MASTER_ADMIN";
    }
  });
  await instance.register(planExpiryPlugin);

  // „Proiecte" — modulul gardat, exact ca în projects.routes.ts.
  await instance.register(
    async (scope) => {
      scope.addHook("preHandler", requireFeature("projects.workflows"));
      scope.get("/api/projects", async () => ({ ok: "citire" }));
      scope.post("/api/projects", async () => ({ ok: "scriere" }));
      scope.patch("/api/projects/:id", async () => ({ ok: "modificare" }));
    },
    {},
  );

  // „Revizii" — un modul de bază, inclus în ambele planuri.
  await instance.register(async (scope) => {
    scope.addHook("preHandler", requireFeature("field.inspections"));
    scope.get("/api/revizii", async () => ({ ok: "citire" }));
    scope.post("/api/revizii", async () => ({ ok: "scriere" }));
  });

  await instance.ready();
  return instance;
}

async function setPlan(tenantId: string, data: { plan?: string; planUntil?: Date | null; overrides?: unknown }) {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      ...(data.plan !== undefined && { plan: data.plan }),
      ...(data.planUntil !== undefined && { planUntil: data.planUntil }),
      ...(data.overrides !== undefined && { entitlementOverrides: data.overrides as never }),
    },
  });
  invalidateEntitlements(tenantId);
}

beforeEach(async () => {
  f = await seedTwoTenants();
  app = await buildGuardedApp();
  session = { sub: f.a.admin.id, tenantId: f.a.id, role: "ADMIN" };
});
afterEach(async () => {
  invalidateEntitlements(f.a.id);
  invalidateEntitlements(f.b.id);
  await app.close();
  session = null;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("requireFeature — firmă pe planul Teren", () => {
  beforeEach(async () => {
    await setPlan(f.a.id, { plan: "field" });
  });

  it("GET pe proiecte trece (firma își vede datele)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: "citire" });
  });

  it("POST pe proiecte → 402, cu feature și upgradeTo în corp", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({
      statusCode: 402,
      error: "Payment Required",
      feature: "projects.workflows",
      upgradeTo: "execution",
    });
    expect(res.json().message).toContain("planul Execuție");
  });

  it("PATCH pe proiecte → 402", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/projects/abc", payload: {} });
    expect(res.statusCode).toBe(402);
  });

  it("modulul de bază (revizii) rămâne deschis la scriere", async () => {
    const res = await app.inject({ method: "POST", url: "/api/revizii", payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it("un add-on per firmă deblochează scrierea fără schimbarea planului", async () => {
    await setPlan(f.a.id, { plan: "field", overrides: { features: { add: ["projects.workflows"] } } });
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it("MASTER_ADMIN trece peste gardă", async () => {
    session = { sub: f.a.admin.id, tenantId: f.a.id, role: "MASTER_ADMIN" };
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it("fără sesiune → 401, nu 402", async () => {
    session = null;
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireFeature — firmă pe planul Execuție", () => {
  it("scrierea pe proiecte trece", async () => {
    await setPlan(f.a.id, { plan: "execution" });
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(res.statusCode).toBe(200);
  });
});

describe("abonament expirat", () => {
  beforeEach(async () => {
    await setPlan(f.a.id, { plan: "execution", planUntil: new Date(Date.now() - 86_400_000) });
  });

  it("blochează scrierea pe un modul de bază (revizii) — garda globală de expirare", async () => {
    const res = await app.inject({ method: "POST", url: "/api/revizii", payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().message).toContain("Abonamentul a expirat");
  });

  it("blochează și scrierea pe un modul inclus în plan (proiecte)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().message).toContain("Abonamentul a expirat");
  });

  it("citirile trec în continuare", async () => {
    expect((await app.inject({ method: "GET", url: "/api/projects" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/revizii" })).statusCode).toBe(200);
  });

  it("un abonament cu termen în viitor nu blochează nimic", async () => {
    await setPlan(f.a.id, { planUntil: new Date(Date.now() + 86_400_000) });
    expect((await app.inject({ method: "POST", url: "/api/revizii", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: {} })).statusCode).toBe(200);
  });
});

describe("garda e per firmă", () => {
  it("planul lui A nu afectează firma B", async () => {
    await setPlan(f.a.id, { plan: "field" });
    await setPlan(f.b.id, { plan: "execution" });

    session = { sub: f.a.admin.id, tenantId: f.a.id, role: "ADMIN" };
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: {} })).statusCode).toBe(402);

    session = { sub: f.b.admin.id, tenantId: f.b.id, role: "ADMIN" };
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: {} })).statusCode).toBe(200);
  });
});
