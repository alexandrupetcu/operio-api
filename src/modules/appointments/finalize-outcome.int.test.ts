import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as appointments from "./appointments.service.js";
import { finalizeAppointmentSchema } from "./appointments.schema.js";
import { listPendingOsRegistrations, setOsSubmission } from "./os-registration.js";

/**
 * „Revenire necesară” / „Programare nouă” închid vizita FĂRĂ raport: nu are ce să se
 * depună la OS, iar raportul se poate completa ulterior pe aceeași vizită (tehnicianul
 * a ales greșit sau s-a întors între timp).
 */
let app: FastifyInstance;
let f: TwoTenants;

const revenire = finalizeAppointmentSchema.parse({ outcome: "revenire", followup: { title: "Revenire pentru piesă" } });
const programareNoua = finalizeAppointmentSchema.parse({
  outcome: "programare_noua",
  newAppointment: { title: "Revizie — piesa a sosit", date: "2026-11-20T08:00:00.000Z", type: "revizie" },
});
const raport = finalizeAppointmentSchema.parse({
  outcome: "raport_complet",
  reportData: {
    verificationType: "verificare_periodica",
    verificationDocuments: { instructions: "DA", conformityDeclaration: "DA", thermoMechanicalSchema: "DA", repairDocumentation: "NA", fuelNotice: "DA" },
    workVerification: { installedCorrect: "DA", repairedCorrect: "NA", connectionGas: "DA", connectionElectricity: "DA", connectionWater: "DA", flueGas: "DA", fuelMatch: "DA", combustionAir: "DA" },
    functionalVerifications: { fuelSealingCheck: "DA", waterSealingCheck: "DA", grounding: "DA", flueGasSealingCheck: "DA", protectionFunctionsCheck: "DA" },
    conclusions: { decision: "admis", nextRevisionDate: "2028-10-27" },
  },
});

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const pendingIds = async () => (await listPendingOsRegistrations(prisma, f.a.id, 5)).map((p) => p.id);

describe("finalizare fără raport", () => {
  it("rezultatul se păstrează pe vizită", async () => {
    const done = await appointments.finalize(app, f.a.id, f.a.appointmentId, programareNoua);
    expect(done.status).toBe("completed");
    expect(done.completionOutcome).toBe("programare_noua");
  });

  it("revenire / programare nouă → nu apare la „de depus la OS” și nu se poate marca depusă", async () => {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire);
    expect(await pendingIds()).not.toContain(f.a.appointmentId);
    const err = await expectReject(() => setOsSubmission(app, f.a.id, f.a.appointmentId, { submittedAt: new Date().toISOString() }));
    expect(err.status).toBe(400);
  });

  it("raportul se completează ulterior pe aceeași vizită → apoi apare la OS", async () => {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, programareNoua);
    const done = await appointments.finalize(app, f.a.id, f.a.appointmentId, raport);
    expect(done.completionOutcome).toBe("raport_complet");
    expect(await pendingIds()).toContain(f.a.appointmentId);
    // Programarea nouă creată la prima finalizare rămâne.
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id, title: "Revizie — piesa a sosit" } })).toBe(1);
  });

  it("o vizită care are deja raport nu primește un al doilea → 409", async () => {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, raport);
    const err = await expectReject(() => appointments.finalize(app, f.a.id, f.a.appointmentId, raport));
    expect(err.status).toBe(409);
  });

  it("fără raport nu se poate închide a doua oară cu revenire → 409", async () => {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire);
    const err = await expectReject(() => appointments.finalize(app, f.a.id, f.a.appointmentId, revenire));
    expect(err.status).toBe(409);
  });

  it("vizitele vechi finalizate fără rezultat (marcate din calendar) rămân la OS", async () => {
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { status: "completed", completedAt: new Date() } });
    expect(await pendingIds()).toContain(f.a.appointmentId);
  });
});
