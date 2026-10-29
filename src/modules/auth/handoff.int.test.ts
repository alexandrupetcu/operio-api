import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { exchangeHandoff, startHandoff } from "./handoff.service.js";

const BASE = { baseDomain: "operio.ro", frontendUrl: "https://app.operio.ro" };
let app: FastifyInstance;
let f: TwoTenants;

beforeEach(async () => {
  app = await serviceStub();
  // Doar `jwt.sign` e nevoie din fastify pentru emiterea tokenurilor.
  (app as unknown as { jwt: { sign: (p: object) => string } }).jwt = { sign: (p: object) => `jwt:${JSON.stringify(p)}` };
  f = await seedTwoTenants();
  await prisma.tenant.update({ where: { id: f.a.id }, data: { subdomain: "picinstall" } });
});
afterAll(closeStub);

const refreshFor = async (userId: string) => {
  const raw = `rt-${Math.random()}`;
  await prisma.refreshToken.create({
    data: { userId, token: createHash("sha256").update(raw).digest("hex"), client: "web", expiresAt: new Date(Date.now() + 3600_000) },
  });
  return raw;
};

describe("mutarea sesiunii pe adresa firmei", () => {
  it("de pe adresa greșită: sesiunea de acolo se închide, linkul duce la subdomeniul firmei", async () => {
    const rt = await refreshFor(f.a.admin.id);
    const { url } = await startHandoff(app, f.a.admin.id, rt, BASE);
    expect(url).toMatch(/^https:\/\/picinstall\.operio\.ro\/auth\/handoff\?code=[a-f0-9]{64}$/);
    expect(await prisma.refreshToken.count({ where: { userId: f.a.admin.id } })).toBe(0);
  });

  it("firma fără subdomeniu e trimisă pe aplicația comună", async () => {
    const { url } = await startHandoff(app, f.b.admin.id, null, BASE);
    expect(url).toMatch(/^https:\/\/app\.operio\.ro\/auth\/handoff\?code=/);
  });

  it("codul dă o sesiune nouă o singură dată, doar pe adresa lui și doar 60 de secunde", async () => {
    const { url } = await startHandoff(app, f.a.admin.id, null, BASE);
    const code = new URL(url).searchParams.get("code")!;
    expect((await expectReject(() => exchangeHandoff(app, code, "https://app.operio.ro"))).status).toBe(400);
    const res = await exchangeHandoff(app, code, "https://picinstall.operio.ro");
    expect(res.user.id).toBe(f.a.admin.id);
    expect(res.tenant?.subdomain).toBe("picinstall");
    expect(res.refreshToken).toBeTruthy();
    expect((await expectReject(() => exchangeHandoff(app, code, "https://picinstall.operio.ro"))).status).toBe(401);

    const late = new URL((await startHandoff(app, f.a.admin.id, null, BASE)).url).searchParams.get("code")!;
    await prisma.sessionHandoff.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await expectReject(() => exchangeHandoff(app, late, "https://picinstall.operio.ro"))).status).toBe(401);
  });

  it("un cont dezactivat între timp nu primește sesiune", async () => {
    const code = new URL((await startHandoff(app, f.a.admin.id, null, BASE)).url).searchParams.get("code")!;
    await prisma.user.update({ where: { id: f.a.admin.id }, data: { isActive: false } });
    expect((await expectReject(() => exchangeHandoff(app, code, "https://picinstall.operio.ro"))).status).toBe(401);
  });
});
