import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { getReadiness, invalidateReadiness } from "./readiness.js";

let app: FastifyInstance;
let f: TwoTenants;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  invalidateReadiness(f.a.id);
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const cert = (employeeId: string, tenantId: string, type: string, over: Record<string, unknown> = {}) =>
  prisma.employeeCertification.create({ data: { tenantId, employeeId, type, number: "1", ...over } });
const warningsOf = async (tenantId = f.a.id) => {
  invalidateReadiness(tenantId);
  return (await getReadiness(app, tenantId)).warnings;
};
const levels = (w: Awaited<ReturnType<typeof warningsOf>>) => Object.fromEntries(w.map((x) => [x.role, x.level]));

describe("onboarding — avertismente pentru semnatari (instalator / RVT / RSL-IP)", () => {
  it("firmă nouă, fără certificări → câte un avertisment „missing” pentru fiecare rol, cu documentele afectate", async () => {
    const w = await warningsOf();
    expect(levels(w)).toEqual({ instalator: "missing", rvt: "missing", rsl: "missing" });
    expect(w.find((x) => x.role === "rvt")!.description).toMatch(/Rapoartele ISCIR .* fără numele și ștampila de RVT/);
    expect(w.every((x) => x.href === "/employees")).toBe(true);
  });

  it("certificare fără ștampilă → „no_stamp”; ștampila pusă pe altă certificare ANRE a aceleiași persoane acoperă rolul", async () => {
    await cert(f.a.employeeId, f.a.id, "anre_egiu");
    expect(levels(await warningsOf()).instalator).toBe("no_stamp");

    await cert(f.a.employeeId, f.a.id, "anre_pgd", { stampS3Key: `${f.a.id}/employees/x/stamp.png` });
    expect(levels(await warningsOf()).instalator).toBeUndefined();
  });

  it("toate certificările rolului expirate → „expired”, chiar dacă au ștampilă", async () => {
    await cert(f.a.employeeId, f.a.id, "iscir_rvt", { expiresAt: new Date("2020-01-01"), stampS3Key: "k" });
    expect(levels(await warningsOf()).rvt).toBe("expired");
  });

  it("angajații inactivi și certificările altei firme nu acoperă rolul", async () => {
    const gone = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Plecat", lastName: "X", isActive: false } });
    await cert(gone.id, f.a.id, "iscir_rsl", { stampS3Key: "k" });
    await cert(f.b.employeeId, f.b.id, "iscir_rsl", { stampS3Key: "k" });
    expect(levels(await warningsOf()).rsl).toBe("missing");
  });

  it("rolurile urmează autorizațiile firmei: doar ANRE → fără avertismente RVT / RSL-IP", async () => {
    await prisma.tenant.update({ where: { id: f.a.id }, data: { settingsJson: { company: { anreNr: "19833" } } } });
    expect(Object.keys(levels(await warningsOf()))).toEqual(["instalator"]);
  });

  it("avertismentele nu schimbă procentul pașilor", async () => {
    const r = await getReadiness(app, f.a.id);
    expect(r.items).toHaveLength(5);
    expect(r.percent).toBe(Math.round((r.items.filter((i) => i.done).length / 5) * 100));
  });
});
