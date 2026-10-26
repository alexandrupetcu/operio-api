import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as revisions from "./revisions.service.js";
import { createDirectRevisionSchema, listRevisionsQuerySchema } from "./revisions.schema.js";

/**
 * Secțiunea „Revizii”: lista tuturor reviziilor firmei (centrală + instalație, inclusiv
 * cele venite doar din PDF) cu filtre pe tip / beneficiar / adresă, și revizia făcută
 * direct, fără programare.
 */
let app: FastifyInstance;
let f: TwoTenants;

const q = (input: Record<string, unknown> = {}) => listRevisionsQuerySchema.parse(input);

async function completedVisit(t: TwoTenants["a"], over: Record<string, unknown>) {
  return prisma.appointment.create({
    data: {
      tenantId: t.id,
      clientId: t.clientId,
      clientAddressId: t.addressId,
      employeeId: t.employeeId,
      type: "verificare_instalatie",
      title: "Verificare",
      date: new Date(2026, 9, 10, 9),
      duration: 60,
      status: "completed",
      completedAt: new Date(2026, 9, 10, 10),
      ...over,
    },
  });
}

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("lista reviziilor firmei", () => {
  it("adună reviziile de centrală (vizită sau doar PDF) și pe cele de instalație; implicit doar cele făcute", async () => {
    const inst = await completedVisit(f.a, { installationId: f.a.installationId, completionDataJson: { reportKind: "verificare_instalatie", decizie: "respins" } });
    const rev = await prisma.equipmentRevision.create({ data: { equipmentId: f.a.equipmentId, revisionDate: new Date(2026, 9, 12) } });
    const centrala = await completedVisit(f.a, {
      type: "revizie",
      equipmentId: f.a.equipmentId,
      equipmentRevisionId: rev.id,
      date: new Date(2026, 9, 11, 9),
      completionDataJson: { conclusions: { decision: "admis", nextRevisionDate: "2028-10-10" } },
    });
    const orphan = await prisma.equipmentRevision.create({ data: { equipmentId: f.a.equipmentId, revisionDate: new Date(2026, 9, 13) } });
    await completedVisit(f.b, { installationId: f.b.installationId });

    const all = await revisions.list(app, f.a.id, q());
    expect(all.meta.total).toBe(3);
    expect(all.data.map((r) => r.id)).toEqual([`rev:${orphan.id}`, centrala.id, inst.id]); // după dată, descrescător
    expect(all.data[1]).toMatchObject({ kind: "centrala", decision: "admis", subject: "Centrală fixture", client: { name: "Ion ClientA" } });
    expect(all.data[2]).toMatchObject({ kind: "instalatie", decision: "respins", subject: "POD-a", address: expect.stringContaining("Str. Fixture a") });
    expect(all.data[0].appointment).toBeNull();
    expect(all.data[0].revision?.id).toBe(orphan.id);

    // Programarea „revizie” din fixture e doar programată: apare la `scheduled` / `all`, nu implicit.
    expect((await revisions.list(app, f.a.id, q({ status: "scheduled" }))).data.map((r) => r.id)).toEqual([f.a.appointmentId]);
    expect((await revisions.list(app, f.a.id, q({ status: "all" }))).meta.total).toBe(4);
  });

  it("filtrele: tip, beneficiar, adresă, POD; firma B nu se vede", async () => {
    await completedVisit(f.a, { installationId: f.a.installationId });
    await completedVisit(f.a, { type: "revizie", equipmentId: f.a.equipmentId, date: new Date(2026, 9, 11, 9) });
    await completedVisit(f.b, { installationId: f.b.installationId });

    expect((await revisions.list(app, f.a.id, q({ kind: "centrala" }))).data.map((r) => r.type)).toEqual(["revizie"]);
    expect((await revisions.list(app, f.a.id, q({ kind: "instalatie" }))).data.map((r) => r.type)).toEqual(["verificare_instalatie"]);
    expect((await revisions.list(app, f.a.id, q({ type: "revizie_instalatie" }))).meta.total).toBe(0);
    expect((await revisions.list(app, f.a.id, q({ q: "clienta" }))).meta.total).toBe(2);
    expect((await revisions.list(app, f.a.id, q({ q: "Fixture a nr. 1" }))).meta.total).toBe(2);
    expect((await revisions.list(app, f.a.id, q({ q: "POD-a" }))).meta.total).toBe(1);
    expect((await revisions.list(app, f.a.id, q({ q: "ClientB" }))).meta.total).toBe(0);
    expect((await revisions.list(app, f.a.id, q({ from: "2026-10-11", to: "2026-10-11" }))).data.map((r) => r.type)).toEqual(["revizie"]);
    const page2 = await revisions.list(app, f.a.id, q({ limit: 1, page: 2 }));
    expect(page2.data).toHaveLength(1);
    expect(page2.meta).toMatchObject({ total: 2, totalPages: 2 });
  });

  it("tehnicianul cu domeniu restrâns vede vizitele lui și pe cele nerepartizate, nu pe ale colegului", async () => {
    const colleague = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Coleg", lastName: "A" } });
    await completedVisit(f.a, { installationId: f.a.installationId });
    await completedVisit(f.a, { installationId: f.a.installationId, employeeId: null, date: new Date(2026, 9, 9, 9) });
    await completedVisit(f.a, { installationId: f.a.installationId, employeeId: colleague.id, date: new Date(2026, 9, 8, 9) });
    const own = await revisions.list(app, f.a.id, q(), { kind: "own", employeeId: f.a.employeeId });
    expect(own.data.map((r) => r.employee?.id ?? null)).toEqual([f.a.employeeId, null]);
  });
});

describe("revizie fără programare", () => {
  const body = (over: Record<string, unknown> = {}) =>
    createDirectRevisionSchema.parse({
      type: "verificare_instalatie",
      clientId: f.a.clientId,
      clientAddressId: f.a.addressId,
      employeeId: f.a.employeeId,
      date: "2026-10-15T08:00:00.000Z",
      report: {
        outcome: "raport_complet",
        installationData: { distributorName: "Distrigaz Sud Rețele", codTehnicPOD: "POD-NOU", clientAddressId: f.a.addressId },
        reportData: { reportKind: "verificare_instalatie", decizie: "admis", nextDate: "15.10.2028" },
      },
      ...over,
    });

  it("creează programarea pe data reviziei, finalizată pe loc, cu instalația și raportul", async () => {
    const appt = await revisions.createDirect(app, f.a.id, body(), "direct-1");
    expect(appt.status).toBe("completed");
    expect(appt.completedAt).toBeInstanceOf(Date);
    expect(appt.type).toBe("verificare_instalatie");
    expect(appt.title).toBe("Verificare instalație — Ion ClientA");
    expect(appt.date.toISOString()).toBe("2026-10-15T08:00:00.000Z");
    const inst = await prisma.gasInstallation.findFirst({ where: { codTehnicPOD: "POD-NOU" } });
    expect(inst?.clientId).toBe(f.a.clientId);
    const listed = await revisions.list(app, f.a.id, q({ q: "POD-NOU" }));
    expect(listed.data.map((r) => r.id)).toEqual([appt.id]);
  });

  it("aceeași cheie de idempotență nu creează a doua programare", async () => {
    const first = await revisions.createDirect(app, f.a.id, body(), "direct-2");
    const again = await revisions.createDirect(app, f.a.id, body(), "direct-2");
    expect(again.id).toBe(first.id);
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id, type: "verificare_instalatie" } })).toBe(1);
  });

  it("clientul altei firme → 404, fără programare creată", async () => {
    const err = await expectReject(() => revisions.createDirect(app, f.a.id, body({ clientId: f.b.clientId, clientAddressId: f.b.addressId }), null));
    expect(err.status).toBe(404);
    expect(await prisma.appointment.count({ where: { type: "verificare_instalatie" } })).toBe(0);
  });

  it("dacă finalizarea pică, programarea abia creată nu rămâne în urmă", async () => {
    // Echipamentul firmei B pe o revizie de centrală din A: finalizarea refuză.
    const bad = body({
      type: "revizie",
      report: {
        outcome: "raport_complet",
        equipmentId: f.b.equipmentId,
        reportData: {
          verificationType: "verificare_periodica",
          verificationDocuments: { instructions: "DA", conformityDeclaration: "DA", thermoMechanicalSchema: "DA", repairDocumentation: "NA", fuelNotice: "DA" },
          workVerification: { installedCorrect: "DA", repairedCorrect: "NA", connectionGas: "DA", connectionElectricity: "DA", connectionWater: "DA", flueGas: "DA", fuelMatch: "DA", combustionAir: "DA" },
          functionalVerifications: { fuelSealingCheck: "DA", waterSealingCheck: "DA", grounding: "DA", flueGasSealingCheck: "DA", protectionFunctionsCheck: "DA" },
          conclusions: { decision: "admis", nextRevisionDate: "2028-10-14" },
        },
      },
    });
    await expectReject(() => revisions.createDirect(app, f.a.id, bad, null));
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id, type: "revizie" } })).toBe(1); // doar cea din fixture
  });
});

describe("revizie directă — tehnicianul implicit", () => {
  it("fără employeeId, vizita creată pe loc e a celui care o înregistrează", async () => {
    const body = createDirectRevisionSchema.parse({
      type: "verificare_instalatie",
      clientId: f.a.clientId,
      clientAddressId: f.a.addressId,
      date: "2026-10-16T08:00:00.000Z",
      report: {
        outcome: "raport_complet",
        installationData: { distributorName: "Distrigaz Sud Rețele", codTehnicPOD: "POD-EMP", clientAddressId: f.a.addressId },
        reportData: { reportKind: "verificare_instalatie", decizie: "admis", nextDate: "16.10.2028" },
      },
    });
    const appt = await revisions.createDirect(app, f.a.id, body, "direct-emp", { defaultEmployeeId: f.a.employeeId });
    expect(appt.employee?.id).toBe(f.a.employeeId);
  });
});
