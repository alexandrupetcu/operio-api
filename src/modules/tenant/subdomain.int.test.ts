import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { brandingFor, setSubdomain, tlsAllowed } from "./subdomain.service.js";

let app: FastifyInstance;
let f: TwoTenants;
beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(closeStub);

describe("subdomeniul firmei", () => {
  it("master adminul îl setează; e unic, validat și se poate scoate", async () => {
    expect((await setSubdomain(app, f.a.id, "picinstall")).subdomain).toBe("picinstall");
    expect((await expectReject(() => setSubdomain(app, f.b.id, "picinstall"))).status).toBe(409);
    expect((await expectReject(() => setSubdomain(app, f.b.id, "api"))).status).toBe(400);
    expect((await expectReject(() => setSubdomain(app, f.b.id, "Pic Install"))).status).toBe(400);
    expect((await setSubdomain(app, f.a.id, null)).subdomain).toBeNull();
  });

  it("pagina de autentificare primește doar numele firmei (și sigla), nimic altceva", async () => {
    await setSubdomain(app, f.a.id, "picinstall");
    const b = await brandingFor(app, "picinstall");
    expect(b).toEqual({ name: expect.any(String), logoUrl: null });
    expect(await brandingFor(app, "altceva")).toBeNull();
  });

  it("certificatul se emite doar pentru subdomeniile active ale domeniului de bază", async () => {
    await setSubdomain(app, f.a.id, "picinstall");
    expect(await tlsAllowed(app, "picinstall.operio.ro", "operio.ro")).toBe(true);
    expect(await tlsAllowed(app, "inventat.operio.ro", "operio.ro")).toBe(false);
    expect(await tlsAllowed(app, "picinstall.evil.ro", "operio.ro")).toBe(false);
    await setSubdomain(app, f.a.id, null);
    expect(await tlsAllowed(app, "picinstall.operio.ro", "operio.ro")).toBe(false);
    expect(await prisma.tenant.count({ where: { subdomain: "picinstall" } })).toBe(0);
  });
});
